/**
 * @hotpath Every visible tile is wanted and every queued request dispatched through here each frame (`want`,
 * `scheduleRequests`, `drainUploads`); records live in typed arrays and nothing is allocated per frame (ADR 0018).
 * @benchmark packages/core/src/globe/frame-allocation.test.ts
 */
import type { RamTier } from '../cache/ram-tier.js';
import type { Residency } from '../cache/residency.hot.js';
import { UPLOAD_REFUSED, UploadQueue } from '../cache/upload-queue.hot.js';
import {
  createFailureDecision,
  decideAfterResult,
  FAILURE_ABORTED,
  FAILURE_NO_DATA,
} from '../scheduler/failure-policy.js';
import { NO_SLOT, type HostOptions, type NetworkPool, type NetworkPoolClient } from '../scheduler/network-pool.js';
import { PriorityHeap } from '../scheduler/priority-heap.hot.js';
import type { DecodedTile, TileRequest, TransportResult } from '../scheduler/types.js';
import type { TileErrorReason } from '../globe/types.js';
import type { Observability } from '../diagnostics/observability.js';
import { WorkerTaskError, type WorkerPool, type WorkerTaskOutcome } from '../scheduler/worker-pool-types.js';
import { LOAD_ALL, LOAD_KEEP_IN_MEMORY, LOAD_PREFETCH, type TileSource } from './imagery-source.js';
import type { TileCoord } from '../tiling/tile-key.js';
import {
  DEAD,
  DECODED,
  DECODING,
  FAILED,
  LOADING,
  NO_DATA,
  QUEUED,
  READY,
  TileTable,
  UNLOADED,
  type TileRecord,
} from './tile-table.js';

/** Priority keys of visible tiles (ADR 0007 class 1) start here: lower keys are the pinned base's. */
export const VISIBLE_CLASS = 1024;
/** Priority keys of prefetched tiles start here, after every visible tile (ADR 0007). */
export const PREFETCH_CLASS = 4 * 1024;
/** Visible tiles per frame whose neighbors are prefetched; more are rare and simply not ringed. */
const RING_CAPACITY = 1024;

/** Runs an inline decode, turning an exception into the failure a worker task reports for bytes it cannot decode. */
function runInline(run: () => DecodedTile): WorkerTaskOutcome {
  try {
    return { ok: true, output: run() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: new WorkerTaskError('task-failed', message, 'undecodable') };
  }
}

/**
 * What {@link ImageryLoader.want} returns for a tile whose bytes are in hand (decoding or waiting for its upload): it
 * arrives within a few frames, so its ancestors need not be requested.
 */
export const ARRIVING = -2;

/** Frames a request in flight survives without being wanted before its consumer leaves (ADR 0007). */
const UNWANTED_FRAMES = 2;
/** Decodes that fail for a reason other than the bytes (worker crash, timeout) are retried this often, backing off. */
const MAX_DECODE_RETRIES = 3;
const DECODE_RETRY_MS = 500;
/** A tile the GPU budget refused waits this long before it is tried again (no re-decoding every frame). */
const REFUSED_RETRY_MS = 1000;
/** Queued tiles of full hosts a dispatch steps over before it gives up for this pass. */
const MAX_HOST_SKIPS = 32;

/**
 * How a tile's bytes are decoded: a worker task by name and input, or `run`, a pure function the loader calls on the
 * main thread between frames (a third-party terrain decoder, ADR 0027), its exception a decode failure.
 */
export interface DecodeTask {
  readonly task: string;
  readonly input: unknown;
  readonly run?: () => DecodedTile;
}

/** A decoded tile waiting for its upload, tagged with its record. */
interface PendingUpload extends DecodedTile {
  slot: number;
}

/** The memory an engine instance's loaders share (ADR 0007): GPU residency and the RAM tier, both keyed by handle. */
export interface TileMemory {
  readonly residency: Residency;
  readonly ram: RamTier;
  /** The current frame number, shared by every loader: what a frame touches or draws is not evicted in it. */
  frame(): number;
}

/** What a loader needs from the engine; core stays DOM-free (ADR 0011). */
export interface ImageryLoaderOptions {
  readonly source: TileSource;
  /**
   * The worker task that decodes a tile's bytes and its input (imagery: `decode-image` or `transcode-ktx2`; terrain:
   * `decode-terrain`). The bytes are transferred to the worker.
   */
  decodeTask(bytes: ArrayBuffer, contentType: string, coord: TileCoord): DecodeTask;
  /** Receives every decoded tile with its coordinates before it queues for upload (terrain metadata, F128). */
  onDecoded?(coord: TileCoord, tile: DecodedTile): void;
  readonly network: NetworkPool;
  readonly workers: WorkerPool;
  readonly memory: TileMemory;
  /** Texture handles of this loader are `handleBase + record slot`; they key the GPU residency and the RAM tier. */
  readonly handleBase: number;
  /** Tiles at this level and coarser form the pinned base (-1: none): loaded first, never evicted (F084). */
  readonly pinnedLevel: number;
  /**
   * The eight neighbors of every visible tile are wanted at the prefetch class while the source prefetches (F284);
   * the engine's layers set it, a loader driven tile by tile (tests) leaves it off.
   */
  readonly prefetchRing?: boolean;
  /** Traces and debug messages of tiles and requests (F120, F121); none when absent. */
  readonly observability?: Observability;
  uploadTexture(handle: number, tile: DecodedTile): void;
  releaseTexture(handle: number): void;
  /** Asks for a frame: something arrived that changes the picture or the queue. */
  requestFrame(): void;
  /** A tile failed for good: its bytes were corrupt, or its retries ran out (F112). Its ancestors stay drawn. */
  tileError(source: TileSource, level: number, x: number, y: number, reason: TileErrorReason): void;
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  random(): number;
}

/** Counters of one loader, summed into `Globe.imageryStats()`. */
export interface ImageryLoaderStats {
  queued: number;
  loading: number;
  decoding: number;
  ready: number;
  failed: number;
  noData: number;
  requested: number;
  uploads: number;
  uploadMsLastFrame: number;
  uploadBytesLastFrame: number;
  uploadsPending: number;
  pinnedSettled: number;
  pinnedTotal: number;
}

/**
 * Loads the tiles of one imagery source for one engine instance (M3 plan §2.3): the frame says which tiles it wants
 * and how urgently; the loader queues them by priority, fetches through the page-wide network pool (or takes the bytes
 * from the RAM tier), decodes in the worker pool and uploads within the per-frame budget into the GPU residency. Wanted
 * tiles that stop being wanted leave the queue at once and release their request after {@link UNWANTED_FRAMES}
 * frames. The pinned base loads before anything else and is never evicted. Lookups and per-frame work allocate
 * nothing; a record, a request and its callbacks are allocated once per tile.
 */
export class ImageryLoader implements NetworkPoolClient {
  private readonly table: TileTable;
  private readonly heap = new PriorityHeap(256, 1024);
  /** Records loading or decoding, checked each frame for being still wanted. */
  private readonly active: TileRecord[] = [];
  /** Slots a dispatch stepped over because their host was full, put back when it ends. */
  private readonly skippedSlots = new Int32Array(MAX_HOST_SKIPS);
  private readonly uploads: UploadQueue<PendingUpload>;
  private readonly decision = createFailureDecision();
  private readonly hosts = new Map<string, number>();
  private readonly removeClient: () => void;
  private readonly pinnedTotal: number;
  private readonly hostOptions: HostOptions;
  /** The source's rate group in the network pool, -1 without a declared rate. */
  private readonly rateIndex: number;
  private pinnedSettled = 0;
  /** The source's loading features this frame (`LOAD_*`). */
  private flags = LOAD_ALL;
  /** Visible tiles wanted this frame (level, x, y, key), whose neighbors are prefetched (F284). */
  private readonly ring = new Float64Array(4 * RING_CAPACITY);
  private ringCount = 0;
  private readonly evictKey = new Float64Array(1);
  private frame = 0;
  private requested = 0;
  private destroyed = false;
  /** 2 while a high-DPI source's `@2x` tiles are wanted (F241). */
  pixelRatio = 1;
  /** Surface levels finer than the source's tiles: 1 for tiles of 512 texels, which serve the next level (F240). */
  levelShift = 0;

  constructor(private readonly options: ImageryLoaderOptions) {
    const { tiling } = options.source;
    this.table = new TileTable(tiling.rootTilesX, options.pinnedLevel);
    let total = 0;
    for (let level = 0; level <= options.pinnedLevel; level++)
      total += tiling.rootTilesX * tiling.rootTilesY * 4 ** level;
    this.pinnedTotal = total;
    const { maxRequestsPerHost, multiplexed, maxRequestsPerSecond } = options.source;
    this.hostOptions = {
      ...(maxRequestsPerHost === undefined ? {} : { maxInFlight: maxRequestsPerHost }),
      ...(multiplexed === undefined ? {} : { multiplexed }),
    };
    // The source's declared rate holds over all its hosts and leaves other sources on them alone (F222, KB-109).
    this.rateIndex = maxRequestsPerSecond === undefined ? -1 : options.network.registerRate(maxRequestsPerSecond);
    this.uploads = new UploadQueue<PendingUpload>({ upload: (tile, measuredMs) => this.upload(tile, measuredMs) });
    this.removeClient = options.network.addClient(this);
  }

  /** Whether the source prefetches now (`loadingFlags`): tiles beyond the view load only when it does (F284, F285). */
  get prefetching(): boolean {
    return (this.flags & LOAD_PREFETCH) !== 0;
  }

  /** True once every pinned tile is on the GPU or known to have no data: refinement may begin (F084). */
  get pinnedComplete(): boolean {
    return this.pinnedSettled >= this.pinnedTotal;
  }

  /** True while any wanted tile is queued, in flight, decoding or waiting for its upload. */
  get busy(): boolean {
    return this.heap.size > 0 || this.active.length > 0 || this.uploads.size > 0;
  }

  /** Starts a frame: tiles not wanted again from now on leave the queue at {@link ImageryLoader.endFrame}. */
  beginFrame(): void {
    this.frame++;
    this.flags = this.options.source.loadingFlags?.() ?? LOAD_ALL;
    this.ringCount = 0;
    // The pinned base is always wanted, ahead of every visible tile (ADR 0007 class 0).
    const { rootTilesX, rootTilesY } = this.options.source.tiling;
    for (let level = 0; level <= this.options.pinnedLevel; level++) {
      const n = 2 ** level;
      for (let y = 0; y < rootTilesY * n; y++) for (let x = 0; x < rootTilesX * n; x++) this.want(level, x, y, level);
    }
  }

  /**
   * Wants a tile this frame with a priority key (lower first). Returns the texture handle when the tile is on the GPU,
   * {@link ARRIVING} when its bytes are being decoded or uploaded, else -1. A tile with no data or a permanent failure returns -1 forever and is never requested again.
   */
  want(level: number, x: number, y: number, priority: number): number {
    const record = this.table.recordFor(level, x, y);
    // The pinned base keeps its class-0 key (its level) when visible tiles also want it, and a tile wanted twice in a
    // frame keeps the lower key: otherwise a visible tile could sit above a pinned one that has to load first (KB-067).
    const previous = this.table.priorities[record.slot] ?? Infinity;
    if (record.pinned) priority = level;
    else if (record.wantedFrame === this.frame && previous < priority) priority = previous;
    record.wantedFrame = this.frame;
    if (priority >= VISIBLE_CLASS && priority < VISIBLE_CLASS + 1024 && this.ringCount < RING_CAPACITY) {
      const at = 4 * this.ringCount++;
      this.ring[at] = level;
      this.ring[at + 1] = x;
      this.ring[at + 2] = y;
      this.ring[at + 3] = priority;
    }
    const handle = this.options.handleBase + record.slot;
    // A tile whose cache headers ran out is requested again, even from the RAM tier (F260).
    if (this.stale(record)) this.expire(record);
    const state = record.state;
    if (state === READY) {
      this.options.memory.residency.touch(handle, this.options.memory.frame());
      return handle;
    }
    const priorities = this.table.priorities;
    priorities[record.slot] = priority;
    // A tile backing off after a failure is wanted again once eligible: from its RAM copy when it has one.
    const retry = state === FAILED && this.options.now() >= (this.table.eligibleAt[record.slot] ?? 0);
    if (state === UNLOADED || retry) {
      const cached = this.options.memory.ram.get(handle);
      if (cached) {
        this.active.push(record);
        this.decode(record, cached.bytes.slice(0), cached.contentType);
        return ARRIVING;
      } else {
        record.state = QUEUED;
        this.heap.pushAt(record.slot, priorities, record.slot);
      }
    } else if (state === DECODING || state === DECODED) {
      return ARRIVING;
    } else if (state === QUEUED) {
      this.heap.updateAt(record.slot, priorities, record.slot);
    }
    return -1;
  }

  /** The handle of a resident tile, without marking it used (elevation queries); -1 when it is not resident. */
  peekHandle(level: number, x: number, y: number): number {
    const record = this.table.find(level, x, y);
    return record?.state === READY ? this.options.handleBase + record.slot : -1;
  }

  /** {@link ImageryLoader.peekHandle} for a tile known to lie in the pyramid (elevation queries, F144). */
  peekInside(level: number, x: number, y: number): number {
    const record = this.table.findInside(level, x, y);
    return record?.state === READY ? this.options.handleBase + record.slot : -1;
  }

  /** The tile uploaded under a texture handle of this loader. */
  coordOf(handle: number): TileCoord | undefined {
    return this.table.bySlot[handle - this.options.handleBase]?.coord;
  }

  /** True for a tile whose source could not tell yet whether it exists, the last time it was asked (F128). */
  availabilityUnknown(level: number, x: number, y: number): boolean {
    return this.table.find(level, x, y)?.availabilityUnknown ?? false;
  }

  /** True for a tile known to have no data (404, outside coverage): it never arrives. */
  noData(level: number, x: number, y: number): boolean {
    return this.table.find(level, x, y)?.state === NO_DATA;
  }

  /**
   * True while a tile cannot come from this source: no data, failed for good, or backing off after a failure until its
   * next try (a source chain then takes it from the next source, F247, F248).
   */
  unavailable(level: number, x: number, y: number): boolean {
    const record = this.table.find(level, x, y);
    if (!record) return false;
    const state = record.state;
    if (state === NO_DATA || state === DEAD) return true;
    return state === FAILED && this.options.now() < (this.table.eligibleAt[record.slot] ?? 0);
  }

  /** True for a tile that failed for good (corrupt, or its retries ran out). */
  failed(level: number, x: number, y: number): boolean {
    return this.table.find(level, x, y)?.state === DEAD;
  }

  /** The texture handle of a tile on the GPU, or -1; does not want it, but keeps it resident this frame. */
  readyHandle(level: number, x: number, y: number): number {
    const record = this.table.find(level, x, y);
    if (record?.state === READY && this.stale(record)) this.expire(record);
    if (record?.state !== READY) return -1;
    const handle = this.options.handleBase + record.slot;
    this.options.memory.residency.touch(handle, this.options.memory.frame());
    return handle;
  }

  /** Records that a frame draws the texture under `handle`: it is not evicted in this frame. */
  markDrawn(handle: number): void {
    this.options.memory.residency.markDrawn(handle, this.options.memory.frame());
  }

  /** Ends a frame: drops what is no longer wanted, starts requests and uploads decoded tiles within the budget. */
  endFrame(): void {
    this.scheduleRequests();
    this.drainUploads();
  }

  /** Drops what the frame no longer wants and starts the best queued requests (the scheduling phase, F118). */
  scheduleRequests(): void {
    if (this.options.prefetchRing === true && (this.flags & LOAD_PREFETCH) !== 0) this.prefetchRing();
    this.dropUnwanted();
    while (this.heap.size > 0 && this.dispatchOne() !== 0);
  }

  /** Uploads decoded tiles within the per-frame budget (the upload phase, F118). */
  drainUploads(): void {
    // A tile uploaded now is drawn from the next frame on; one still waiting needs another frame too.
    if (this.uploads.drain() > 0 || this.uploads.size > 0) this.options.requestFrame();
  }

  /** The GPU residency evicted the texture of a slot: its tile can be loaded again, from RAM if still there. */
  evicted(slot: number): void {
    const record = this.table.bySlot[slot];
    if (!record) return;
    this.options.releaseTexture(this.options.handleBase + slot);
    record.state = UNLOADED;
    this.observe(record, 'tile', 'evicted');
  }

  /** NetworkPoolClient: the best queued priority (one queue for every host). */
  bestQueuedPriority(): number {
    const slot = this.heap.peek();
    return slot < 0 ? Infinity : (this.table.priorities[slot] ?? Infinity);
  }

  /** NetworkPoolClient: a slot freed up; start the best queued request. */
  grant(): boolean {
    return this.dispatchOne() === 1;
  }

  /** Tiles uploaded so far, read without allocating (each frame, by data layers on the terrain: ADR 0037). */
  get uploadedCount(): number {
    return this.uploads.uploadedCount;
  }

  /** Adds this loader's counters to `out`. */
  addStats(out: ImageryLoaderStats): void {
    out.queued += this.heap.size;
    for (const record of this.table.bySlot) {
      if (record.state === LOADING) out.loading++;
      else if (record.state === DECODING || record.state === DECODED) out.decoding++;
      else if (record.state === READY) out.ready++;
      else if (record.state === FAILED || record.state === DEAD) out.failed++;
      else if (record.state === NO_DATA) out.noData++;
    }
    out.requested += this.requested;
    out.uploads += this.uploads.uploadedCount;
    out.uploadMsLastFrame += this.uploads.lastDrainMs;
    out.uploadBytesLastFrame += this.uploads.lastDrainBytes;
    out.uploadsPending += this.uploads.size;
    out.pinnedSettled += this.pinnedSettled;
    out.pinnedTotal += this.pinnedTotal;
  }

  /**
   * Forgets every tile of the source (a new package version, a mode that reaches tiles it could not, KB-PT-19): requests
   * and decodes in progress are cancelled, GPU textures and RAM copies released, no-data and failure marks cleared,
   * so the tiles the next frames want load again from the source.
   */
  reload(): void {
    const { residency, ram } = this.options.memory;
    for (const record of this.table.bySlot) {
      const handle = this.options.handleBase + record.slot;
      if (record.state === QUEUED) this.heap.remove(record.slot);
      else this.cancel(record);
      if (record.state === READY && residency.release(handle)) this.options.releaseTexture(handle);
      ram.delete(handle);
      record.state = UNLOADED;
      record.retries = 0;
      record.availabilityUnknown = false;
    }
    this.active.length = 0;
    this.pinnedSettled = 0;
    this.options.requestFrame();
  }

  /** True for a tile whose cache headers no longer allow reusing it (F260). */
  private stale(record: TileRecord): boolean {
    return record.freshUntilMs !== Infinity && this.options.now() >= record.freshUntilMs;
  }

  /** Drops a stale tile from the GPU and the RAM tier, so wanting it requests it again; its ancestors show meanwhile. */
  private expire(record: TileRecord): void {
    const handle = this.options.handleBase + record.slot;
    if (record.state === READY) {
      if (this.options.memory.residency.release(handle)) this.options.releaseTexture(handle);
      record.state = UNLOADED;
    }
    this.options.memory.ram.delete(handle);
    record.freshUntilMs = Infinity;
  }

  /** Cancels everything in flight; the textures are released by the renderer. */
  destroy(): void {
    this.destroyed = true;
    this.removeClient();
    for (const record of this.active) this.cancel(record);
    this.active.length = 0;
    this.uploads.clear(closeImage);
  }

  /**
   * Wants the eight neighbors of every visible tile at the prefetch class, in the visible tiles' order (F284): the ring
   * just outside the view loads after everything in it.
   */
  private prefetchRing(): void {
    const { rootTilesX, rootTilesY } = this.options.source.tiling;
    const count = this.ringCount;
    for (let i = 0; i < count; i++) {
      const at = 4 * i;
      const level = this.ring[at] ?? 0;
      const x = this.ring[at + 1] ?? 0;
      const y = this.ring[at + 2] ?? 0;
      const key = PREFETCH_CLASS + (this.ring[at + 3] ?? 0) - VISIBLE_CLASS;
      const columns = rootTilesX * 2 ** level;
      const rows = rootTilesY * 2 ** level;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= rows) continue;
        for (let dx = -1; dx <= 1; dx++)
          if (dx !== 0 || dy !== 0) this.want(level, (x + dx + columns) % columns, ny, key);
      }
    }
  }

  private dropUnwanted(): void {
    const keep = (this.flags & LOAD_KEEP_IN_MEMORY) !== 0;
    // Queued tiles nobody wanted this frame leave the queue now (ADR 0007).
    for (const record of this.table.bySlot) {
      if (record.state === QUEUED && record.wantedFrame !== this.frame) {
        this.heap.remove(record.slot);
        record.state = UNLOADED;
      } else if (!keep && record.state === READY && record.wantedFrame !== this.frame && !record.pinned) {
        // Memory reuse off (F282): a tile no frame uses leaves the GPU and RAM at once; one still drawn (a fallback
        // ancestor, a fade) is kept by the residency until it is not.
        const handle = this.options.handleBase + record.slot;
        this.evictKey[0] = handle;
        if (this.options.memory.residency.evictAt(this.evictKey, 0)) this.options.memory.ram.delete(handle);
      }
    }
    let cancelling = false;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const record = this.active[i];
      if (!record || record.wantedFrame === this.frame) continue;
      if (this.frame - record.wantedFrame < UNWANTED_FRAMES) {
        cancelling = true;
        continue;
      }
      this.cancel(record);
      // Cancelling may already have removed it (a worker pool reports the cancel at once): remove it, not index i.
      this.leaveActive(record);
    }
    // A request no longer wanted is cancelled by a later frame: ask for it, even when nothing else would draw (KB-105).
    if (cancelling) this.options.requestFrame();
  }

  private cancel(record: TileRecord): void {
    if (record.state === LOADING) this.observe(record, 'request', 'cancel');
    if (record.state === LOADING && record.consumer !== NO_SLOT) this.options.network.release(record.consumer);
    if (record.state === DECODING && record.task >= 0) this.options.workers.cancel(record.task);
    if (record.state === DECODED) {
      const tile = this.uploads.remove(record.slot);
      if (tile) closeImage(tile);
    }
    record.consumer = NO_SLOT;
    record.task = -1;
    if (record.state !== READY) record.state = UNLOADED;
  }

  /**
   * Starts the best queued request: 1 when started, 0 when it must wait (no free slot, or the pinned base is still
   * loading and the tile is not part of it), -1 when the tile had no data or its availability is not known yet.
   */
  private dispatchOne(): number {
    if (this.destroyed) return 0;
    // A tile whose host is full steps aside for the next ones, so a busy host never holds back the others (ADR 0007:
    // one queue, limits per host); the skipped tiles go back to the queue with their keys.
    let skipped = 0;
    let result = 0;
    for (;;) {
      const slot = this.heap.peek();
      const record = slot >= 0 ? this.table.bySlot[slot] : undefined;
      if (!record || (!record.pinned && !this.pinnedComplete)) break;
      const request = this.options.source.request(record.coord, { url: '', hostIndex: 0 }, this.pixelRatio);
      if (request === 'noData') {
        this.heap.pop();
        record.state = NO_DATA;
        record.availabilityUnknown = false;
        this.settlePinned(record);
        result = -1;
        break;
      }
      if (request === 'unknown') {
        // Not known yet (availability that comes with an ancestor's metadata, F128): asked again when wanted again.
        this.heap.pop();
        record.state = UNLOADED;
        record.availabilityUnknown = true;
        result = -1;
        break;
      }
      record.availabilityUnknown = false;
      // Keyed by URL: another layer or engine instance on the page wanting the same tile shares the request (F095).
      const consumer = this.options.network.request(
        request.url,
        this.hostOf(request),
        this.options.source.transport,
        (outcome) => this.received(record, outcome),
        this.options.source.timeoutsMs,
        this.rateIndex,
      );
      this.heap.pop();
      if (consumer === NO_SLOT) {
        if (skipped === MAX_HOST_SKIPS) {
          this.heap.pushAt(slot, this.table.priorities, slot);
          break;
        }
        this.skippedSlots[skipped++] = slot;
        continue;
      }
      this.started(record, consumer);
      result = 1;
      break;
    }
    for (let i = 0; i < skipped; i++) {
      const slot = this.skippedSlots[i] ?? 0;
      this.heap.pushAt(slot, this.table.priorities, slot);
    }
    return result;
  }

  /** A request of a tile started under `consumer`. */
  private started(record: TileRecord, consumer: number): void {
    this.requested++;
    this.observe(record, 'request', 'start');
    // A synchronous transport may already have answered.
    if (record.state === QUEUED) {
      record.state = LOADING;
      record.consumer = consumer;
      this.active.push(record);
    }
  }

  /** The request with the page-wide index of its host, registered on first use. */
  private hostOf(request: TileRequest): TileRequest {
    const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/]+/i.exec(request.url)?.[0] ?? '';
    let hostIndex = this.hosts.get(origin);
    if (hostIndex === undefined) {
      hostIndex = this.options.network.registerHost(origin, this.hostOptions);
      this.hosts.set(origin, hostIndex);
    }
    return { url: request.url, hostIndex };
  }

  private received(record: TileRecord, result: TransportResult): void {
    if (this.destroyed) return;
    record.consumer = NO_SLOT;
    this.observe(record, 'request', result.kind === 'ok' ? 'end' : result.kind === 'aborted' ? 'cancel' : 'fail');
    if (result.kind === 'ok') {
      record.freshUntilMs =
        result.maxAgeMs !== undefined && this.options.source.profile?.respectCacheHeaders === true
          ? this.options.now() + result.maxAgeMs
          : Infinity;
      // The RAM tier keeps a copy: the bytes themselves move to the worker.
      this.options.memory.ram.put(this.options.handleBase + record.slot, {
        bytes: result.bytes.slice(0),
        contentType: result.contentType,
      });
      this.decode(record, result.bytes, result.contentType);
      return;
    }
    this.leaveActive(record);
    const decision = decideAfterResult(result, record.retries, this.options.now(), this.options.random, this.decision);
    if (decision.failureClass === FAILURE_ABORTED) {
      record.state = UNLOADED;
    } else if (decision.failureClass === FAILURE_NO_DATA) {
      record.state = NO_DATA;
    } else if (decision.retry) {
      record.state = FAILED;
      record.retries++;
      this.table.eligibleAt[record.slot] = decision.nextEligibleMs;
      // Wake a frame when the retry becomes eligible: nothing else would.
      this.options.setTimer(() => this.options.requestFrame(), decision.nextEligibleMs - this.options.now());
    } else {
      record.state = DEAD;
      this.reportError(record, result.kind === 'network-error' && result.cause === 'cors' ? 'cors' : 'failed');
    }
    this.settlePinned(record);
    this.options.requestFrame();
  }

  /** Backs a tile off after a decode that failed for a reason other than its bytes, or reports it for good. */
  private retryLater(record: TileRecord): void {
    if (++record.retries > MAX_DECODE_RETRIES) {
      record.state = DEAD;
      this.reportError(record, 'failed');
      return;
    }
    record.state = FAILED;
    const delayMs = DECODE_RETRY_MS * 2 ** (record.retries - 1);
    this.table.eligibleAt[record.slot] = this.options.now() + delayMs;
    this.options.setTimer(() => this.options.requestFrame(), delayMs);
  }

  private reportError(record: TileRecord, reason: TileErrorReason): void {
    this.observe(record, 'tile', 'failed');
    const { level, x, y } = record.coord;
    this.options.tileError(this.options.source, level, x, y, reason);
  }

  private decode(record: TileRecord, bytes: ArrayBuffer, contentType: string): void {
    record.state = DECODING;
    const request = this.options.decodeTask(bytes, contentType, record.coord);
    const run = request.run;
    if (run) {
      // Between frames, in a timer of its own, like a worker's reply.
      record.task = -1;
      this.options.setTimer(() => this.decoded(record, runInline(run)), 0);
      return;
    }
    record.task = this.options.workers.run(
      {
        task: request.task,
        input: request.input,
        transfer: [bytes],
        priority: this.table.priorities[record.slot] ?? 0,
      },
      (outcome) => this.decoded(record, outcome),
    );
  }

  private decoded(record: TileRecord, outcome: WorkerTaskOutcome): void {
    record.task = -1;
    if (this.destroyed || record.state !== DECODING) {
      if (outcome.ok) closeImage(outcome.output as DecodedTile);
      return;
    }
    if (!outcome.ok) {
      this.leaveActive(record);
      const code = outcome.error.code;
      if (code === 'cancelled' || code === 'aborted') {
        record.state = UNLOADED;
      } else if (code === 'task-failed' && outcome.error.taskCode === 'unsupported') {
        record.state = NO_DATA;
      } else if (code === 'task-failed' && outcome.error.taskCode === 'format-unsupported') {
        // Valid data the engine or device cannot use: reported once, never retried (ADR 0020 rule 4).
        record.state = DEAD;
        this.options.memory.ram.delete(this.options.handleBase + record.slot);
        this.reportError(record, 'unsupported');
      } else if (code === 'task-failed') {
        // Bytes of a declared format that do not decode: quarantined, reported once, never retried (M3 plan risk 9).
        record.state = DEAD;
        this.options.memory.ram.delete(this.options.handleBase + record.slot);
        this.reportError(record, 'corrupt');
      } else {
        // The worker crashed, timed out or is unavailable: retried with backoff from the RAM copy, at most
        // MAX_DECODE_RETRIES times, then reported (F091).
        this.retryLater(record);
      }
      this.settlePinned(record);
      this.options.requestFrame();
      return;
    }
    const tile = outcome.output as PendingUpload;
    this.options.onDecoded?.(record.coord, tile);
    tile.slot = record.slot;
    record.state = DECODED;
    // The pinned base uploads first (class 0 keys are the lowest).
    this.uploads.enqueue(record.slot, this.table.priorities[record.slot] ?? 0, tile, false);
    this.options.requestFrame();
  }

  private upload(tile: PendingUpload, measuredMs: Float64Array): void {
    const record = this.table.bySlot[tile.slot];
    if (!record) return;
    const handle = this.options.handleBase + record.slot;
    const residency = this.options.memory.residency;
    this.leaveActive(record);
    // Over the GPU budget with nothing evictable: refused and counted; the bytes stay in RAM for a later frame.
    if (!residency.admit(handle, tile.gpuBytes)) {
      // Not uploaded: not counted. The bytes stay in RAM; the tile waits before it is tried again, and meanwhile its
      // ancestors are drawn and requested.
      closeImage(tile);
      record.state = FAILED;
      this.table.eligibleAt[record.slot] = this.options.now() + REFUSED_RETRY_MS;
      this.options.setTimer(() => this.options.requestFrame(), REFUSED_RETRY_MS);
      measuredMs[0] = UPLOAD_REFUSED;
      return;
    }
    const startMs = this.options.now();
    this.options.uploadTexture(handle, tile);
    measuredMs[0] = this.options.now() - startMs;
    residency.touch(handle, this.options.memory.frame());
    if (record.pinned) residency.setPinned(handle, true);
    record.state = READY;
    this.observe(record, 'tile', 'ready');
    this.settlePinned(record);
  }

  /** Counts a pinned tile once it is resident or known to have no data. */
  private settlePinned(record: TileRecord): void {
    if (!record.pinned || (record.state !== READY && record.state !== NO_DATA && record.state !== DEAD)) return;
    this.pinnedSettled++;
  }

  /** Traces an event and logs requests at the debug level; builds nothing while both are off. */
  private observe(record: TileRecord, kind: 'tile' | 'request', event: string): void {
    const observability = this.options.observability;
    if (!observability) return;
    const tracing = observability.tracer.enabled;
    const logging = kind === 'request' && event === 'start' && observability.logger.enabled('debug');
    if (!tracing && !logging) return;
    const subject = `${record.coord.level}/${record.coord.x}/${record.coord.y}`;
    if (tracing) observability.tracer.record(kind, event, subject);
    if (logging) observability.logger.log('debug', `${this.options.source.id}: request ${subject}`);
  }

  private leaveActive(record: TileRecord): void {
    const at = this.active.indexOf(record);
    if (at >= 0) this.active.splice(at, 1);
  }
}

function closeImage(tile: DecodedTile): void {
  (tile.image as { close?: () => void }).close?.();
}
