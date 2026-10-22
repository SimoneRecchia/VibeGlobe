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
import type { WorkerPool, WorkerTaskOutcome } from '../scheduler/worker-pool-types.js';
import type { TileSource } from './imagery-source.js';
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
  decodeTask(
    bytes: ArrayBuffer,
    contentType: string,
    level: number,
  ): { readonly task: string; readonly input: unknown };
  readonly network: NetworkPool;
  readonly workers: WorkerPool;
  readonly memory: TileMemory;
  /** Texture handles of this loader are `handleBase + record slot`; they key the GPU residency and the RAM tier. */
  readonly handleBase: number;
  /** Tiles at this level and coarser form the pinned base (-1: none): loaded first, never evicted (F084). */
  readonly pinnedLevel: number;
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
  private pinnedSettled = 0;
  private frame = 0;
  private requested = 0;
  private destroyed = false;

  constructor(private readonly options: ImageryLoaderOptions) {
    const { tiling } = options.source;
    this.table = new TileTable(tiling.rootTilesX, options.pinnedLevel);
    let total = 0;
    for (let level = 0; level <= options.pinnedLevel; level++)
      total += tiling.rootTilesX * tiling.rootTilesY * 4 ** level;
    this.pinnedTotal = total;
    const { maxRequestsPerHost, multiplexed } = options.source;
    this.hostOptions = {
      ...(maxRequestsPerHost === undefined ? {} : { maxInFlight: maxRequestsPerHost }),
      ...(multiplexed === undefined ? {} : { multiplexed }),
    };
    this.uploads = new UploadQueue<PendingUpload>({ upload: (tile, measuredMs) => this.upload(tile, measuredMs) });
    this.removeClient = options.network.addClient(this);
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
    const state = record.state;
    const handle = this.options.handleBase + record.slot;
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

  /** The texture handle of a tile on the GPU, or -1; does not want it, but keeps it resident this frame. */
  readyHandle(level: number, x: number, y: number): number {
    const record = this.table.find(level, x, y);
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

  /** Cancels everything in flight; the textures are released by the renderer. */
  destroy(): void {
    this.destroyed = true;
    this.removeClient();
    for (const record of this.active) this.cancel(record);
    this.active.length = 0;
    this.uploads.clear(closeImage);
  }

  private dropUnwanted(): void {
    // Queued tiles nobody wanted this frame leave the queue now (ADR 0007).
    for (const record of this.table.bySlot) {
      if (record.state === QUEUED && record.wantedFrame !== this.frame) {
        this.heap.remove(record.slot);
        record.state = UNLOADED;
      }
    }
    for (let i = this.active.length - 1; i >= 0; i--) {
      const record = this.active[i];
      if (!record || this.frame - record.wantedFrame < UNWANTED_FRAMES) continue;
      this.cancel(record);
      // Cancelling may already have removed it (a worker pool reports the cancel at once): remove it, not index i.
      this.leaveActive(record);
    }
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
   * loading and the tile is not part of it), -1 when the tile had no data.
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
      const request = this.options.source.request(record.coord, { url: '', hostIndex: 0 });
      if (request === 'noData') {
        this.heap.pop();
        record.state = NO_DATA;
        this.settlePinned(record);
        result = -1;
        break;
      }
      // Keyed by URL: another layer or engine instance on the page wanting the same tile shares the request (F095).
      const consumer = this.options.network.request(
        request.url,
        this.hostOf(request),
        this.options.source.transport,
        (outcome) => this.received(record, outcome),
        this.options.source.timeoutsMs,
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
      this.reportError(record, 'failed');
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
    record.task = this.options.workers.run(
      {
        ...this.options.decodeTask(bytes, contentType, record.coord.level),
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
