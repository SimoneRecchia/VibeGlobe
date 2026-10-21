import { IntegerKeyMap } from '../collections/integer-key-map.hot.js';
import { UploadQueue } from '../cache/upload-queue.hot.js';
import {
  createFailureDecision,
  decideAfterResult,
  FAILURE_ABORTED,
  FAILURE_NO_DATA,
} from '../scheduler/failure-policy.js';
import { NO_SLOT, type NetworkPool, type NetworkPoolClient } from '../scheduler/network-pool.js';
import { PriorityHeap } from '../scheduler/priority-heap.hot.js';
import type { DecodedTile, TileRequest, TransportResult } from '../scheduler/types.js';
import type { WorkerPool, WorkerTaskOutcome } from '../scheduler/worker-pool-types.js';
import { packTileKey, type TileCoord } from '../tiling/tile-key.js';
import type { ImagerySource } from './imagery-source.js';

/** States of an imagery tile (M3 plan §3). */
const UNLOADED = 0;
const QUEUED = 1;
const LOADING = 2;
const DECODING = 3;
const DECODED = 4;
const READY = 5;
/** A transient failure: requested again once eligible and still wanted. */
const FAILED = 6;
/** Exhausted retries or corrupt bytes: never requested again; ancestors stay drawn. */
const DEAD = 7;
const NO_DATA = 8;

/** Frames a request in flight survives without being wanted before its consumer leaves (ADR 0007). */
const UNWANTED_FRAMES = 2;

interface TileRecord {
  readonly slot: number;
  readonly coord: TileCoord;
  state: number;
  /** The frame that last wanted the tile. */
  wantedFrame: number;
  retries: number;
  /** Network consumer id while loading, worker task id while decoding. */
  consumer: number;
  task: number;
}

/** A decoded tile waiting for its upload, tagged with its record. */
interface PendingUpload extends DecodedTile {
  slot: number;
}

/** What a loader needs from the engine; core stays DOM-free (ADR 0011). */
export interface ImageryLoaderOptions {
  readonly source: ImagerySource;
  readonly network: NetworkPool;
  readonly workers: WorkerPool;
  /** Texture handles of this loader are `handleBase + record slot`. */
  readonly handleBase: number;
  uploadTexture(handle: number, tile: DecodedTile): void;
  /** Asks for a frame: something arrived that changes the picture or the queue. */
  requestFrame(): void;
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  random(): number;
}

/** Counters of one loader. */
export interface ImageryLoaderStats {
  queued: number;
  loading: number;
  decoding: number;
  ready: number;
  failed: number;
  noData: number;
  requested: number;
}

/**
 * Loads the tiles of one imagery source for one engine instance (M3 plan §2.3): the frame says which tiles it wants
 * and how urgently; the loader queues them by priority, fetches through the page-wide network pool, decodes in the
 * worker pool and uploads within the per-frame budget. Wanted tiles that stop being wanted leave the queue at once and
 * release their request after {@link UNWANTED_FRAMES} frames. Lookups and per-frame work allocate nothing; a record,
 * a request and its callbacks are allocated once per tile.
 */
export class ImageryLoader implements NetworkPoolClient {
  private readonly records = new IntegerKeyMap<TileRecord>(1024);
  private readonly bySlot: TileRecord[] = [];
  private priorities = new Float64Array(1024);
  /** Engine time from which a failed tile may be requested again, by slot. */
  private eligibleAt = new Float64Array(1024);
  private readonly heap = new PriorityHeap(256, 1024);
  /** Records loading or decoding, checked each frame for being still wanted. */
  private readonly active: TileRecord[] = [];
  private readonly uploads: UploadQueue<PendingUpload>;
  private readonly request: TileRequest = { url: '', hostIndex: 0 };
  private readonly coord: TileCoord = { root: 0, level: 0, x: 0, y: 0 };
  private readonly decision = createFailureDecision();
  private readonly hosts = new Map<string, number>();
  private readonly removeClient: () => void;
  private frame = 0;
  private requested = 0;
  private destroyed = false;

  constructor(private readonly options: ImageryLoaderOptions) {
    this.uploads = new UploadQueue<PendingUpload>({ upload: (tile, measuredMs) => this.upload(tile, measuredMs) });
    this.removeClient = options.network.addClient(this);
  }

  /** Starts a frame: tiles not wanted again from now on leave the queue at {@link ImageryLoader.endFrame}. */
  beginFrame(): void {
    this.frame++;
  }

  /**
   * Wants a tile this frame with a priority key (lower first). Returns the texture handle when the tile is on the GPU,
   * else -1. A tile with no data or a permanent failure returns -1 forever and is never requested again.
   */
  want(level: number, x: number, y: number, priority: number): number {
    const record = this.recordFor(level, x, y);
    record.wantedFrame = this.frame;
    const state = record.state;
    if (state === READY) return this.options.handleBase + record.slot;
    this.priorities[record.slot] = priority;
    if (state === UNLOADED) {
      record.state = QUEUED;
      this.heap.pushAt(record.slot, this.priorities, record.slot);
    } else if (state === QUEUED) {
      this.heap.updateAt(record.slot, this.priorities, record.slot);
    } else if (state === FAILED && this.eligible(record)) {
      record.state = QUEUED;
      this.heap.pushAt(record.slot, this.priorities, record.slot);
    }
    return -1;
  }

  /** The texture handle of a tile on the GPU, or -1; does not want it. */
  readyHandle(level: number, x: number, y: number): number {
    const record = this.find(level, x, y);
    return record?.state === READY ? this.options.handleBase + record.slot : -1;
  }

  /** Ends a frame: drops what is no longer wanted, starts requests and uploads decoded tiles within the budget. */
  endFrame(): void {
    this.dropUnwanted();
    this.dispatch();
    // A tile uploaded now is drawn from the next frame on; one still waiting needs another frame too.
    if (this.uploads.drain() > 0 || this.uploads.size > 0) this.options.requestFrame();
  }

  /** NetworkPoolClient: the best queued priority (one queue for every host). */
  bestQueuedPriority(): number {
    const slot = this.heap.peek();
    return slot < 0 ? Infinity : (this.priorities[slot] ?? Infinity);
  }

  /** NetworkPoolClient: a slot freed up; start the best queued request. */
  grant(): boolean {
    return this.dispatchOne() === 1;
  }

  /** Writes the counters into `out`. */
  readStats(out: ImageryLoaderStats): ImageryLoaderStats {
    out.queued = this.heap.size;
    out.loading = 0;
    out.decoding = 0;
    out.ready = 0;
    out.failed = 0;
    out.noData = 0;
    for (const record of this.bySlot) {
      if (record.state === LOADING) out.loading++;
      else if (record.state === DECODING || record.state === DECODED) out.decoding++;
      else if (record.state === READY) out.ready++;
      else if (record.state === FAILED || record.state === DEAD) out.failed++;
      else if (record.state === NO_DATA) out.noData++;
    }
    out.requested = this.requested;
    return out;
  }

  /** True while any wanted tile is queued, in flight, decoding or waiting for its upload. */
  get busy(): boolean {
    return this.heap.size > 0 || this.active.length > 0 || this.uploads.size > 0;
  }

  /** Cancels everything in flight; the textures are released by the renderer. */
  destroy(): void {
    this.destroyed = true;
    this.removeClient();
    for (const record of this.active) this.cancel(record);
    this.active.length = 0;
    this.uploads.clear((tile) => (tile.image as { close?: () => void }).close?.());
  }

  private find(level: number, x: number, y: number): TileRecord | undefined {
    const coord = this.coord;
    coord.level = level;
    coord.x = x;
    coord.y = y;
    return this.records.get(packTileKey(coord, this.options.source.tiling.rootTilesX, 1));
  }

  private recordFor(level: number, x: number, y: number): TileRecord {
    return this.find(level, x, y) ?? this.createRecord(level, x, y);
  }

  private createRecord(level: number, x: number, y: number): TileRecord {
    const slot = this.bySlot.length;
    const record: TileRecord = {
      slot,
      coord: { root: 0, level, x, y },
      state: UNLOADED,
      wantedFrame: 0,
      retries: 0,
      consumer: NO_SLOT,
      task: -1,
    };
    this.bySlot.push(record);
    this.records.set(packTileKey(record.coord, this.options.source.tiling.rootTilesX, 1), record);
    if (slot >= this.priorities.length) {
      this.priorities = grown(this.priorities);
      this.eligibleAt = grown(this.eligibleAt);
    }
    return record;
  }

  /** A failed tile may be requested again once its backoff has passed. */
  private eligible(record: TileRecord): boolean {
    return this.options.now() >= (this.eligibleAt[record.slot] ?? 0);
  }

  private dropUnwanted(): void {
    // Queued tiles nobody wanted this frame leave the queue now (ADR 0007).
    for (const record of this.bySlot) {
      if (record.state === QUEUED && record.wantedFrame !== this.frame) {
        this.heap.remove(record.slot);
        record.state = UNLOADED;
      }
    }
    for (let i = this.active.length - 1; i >= 0; i--) {
      const record = this.active[i];
      if (!record || this.frame - record.wantedFrame < UNWANTED_FRAMES) continue;
      this.cancel(record);
      this.active.splice(i, 1);
    }
  }

  private cancel(record: TileRecord): void {
    if (record.state === LOADING && record.consumer !== NO_SLOT) this.options.network.release(record.consumer);
    if (record.state === DECODING && record.task >= 0) this.options.workers.cancel(record.task);
    if (record.state === DECODED) {
      const tile = this.uploads.remove(record.slot);
      (tile?.image as { close?: () => void } | undefined)?.close?.();
    }
    record.consumer = NO_SLOT;
    record.task = -1;
    if (record.state !== READY) record.state = UNLOADED;
  }

  private dispatch(): void {
    while (this.heap.size > 0 && this.dispatchOne() !== 0);
  }

  /** Starts the best queued request: 1 when started, 0 when no slot was free, -1 when the tile had no data. */
  private dispatchOne(): number {
    if (this.destroyed) return 0;
    const slot = this.heap.peek();
    const record = slot >= 0 ? this.bySlot[slot] : undefined;
    if (!record) return 0;
    const request = this.options.source.request(record.coord, this.request);
    if (request === 'noData') {
      this.heap.pop();
      record.state = NO_DATA;
      return -1;
    }
    const key = `${this.options.source.id}/${record.slot}`;
    const consumer = this.options.network.request(key, this.hostOf(request), this.options.source.transport, (result) =>
      this.received(record, result),
    );
    if (consumer === NO_SLOT) return 0;
    this.heap.pop();
    this.requested++;
    // A synchronous transport may already have answered.
    if (record.state === QUEUED) {
      record.state = LOADING;
      record.consumer = consumer;
      this.active.push(record);
    }
    return 1;
  }

  /** The request with the page-wide index of its host, registered on first use. */
  private hostOf(request: TileRequest): TileRequest {
    const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/]+/i.exec(request.url)?.[0] ?? '';
    let hostIndex = this.hosts.get(origin);
    if (hostIndex === undefined) {
      hostIndex = this.options.network.registerHost(origin);
      this.hosts.set(origin, hostIndex);
    }
    return { url: request.url, hostIndex };
  }

  private received(record: TileRecord, result: TransportResult): void {
    if (this.destroyed) return;
    record.consumer = NO_SLOT;
    if (result.kind === 'ok') {
      record.state = DECODING;
      record.task = this.options.workers.run(
        {
          task: 'decode-image',
          input: { bytes: result.bytes, contentType: result.contentType },
          transfer: [result.bytes],
          priority: this.priorities[record.slot] ?? 0,
        },
        (outcome) => this.decoded(record, outcome),
      );
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
      this.eligibleAt[record.slot] = decision.nextEligibleMs;
      // Wake a frame when the retry becomes eligible: nothing else would.
      this.options.setTimer(() => this.options.requestFrame(), decision.nextEligibleMs - this.options.now());
    } else {
      record.state = DEAD;
    }
    this.options.requestFrame();
  }

  private decoded(record: TileRecord, outcome: WorkerTaskOutcome): void {
    record.task = -1;
    if (this.destroyed) {
      if (outcome.ok) closeImage(outcome.output as DecodedTile);
      return;
    }
    if (!outcome.ok) {
      this.leaveActive(record);
      const code = outcome.error.code;
      if (code === 'cancelled' || code === 'aborted') record.state = UNLOADED;
      else if (code === 'task-failed') record.state = outcome.error.taskCode === 'unsupported' ? NO_DATA : DEAD;
      else record.state = FAILED;
      this.options.requestFrame();
      return;
    }
    const tile = outcome.output as PendingUpload;
    tile.slot = record.slot;
    record.state = DECODED;
    this.uploads.enqueue(record.slot, this.priorities[record.slot] ?? 0, tile, false);
    this.options.requestFrame();
  }

  private upload(tile: PendingUpload, measuredMs: Float64Array): void {
    const record = this.bySlot[tile.slot];
    if (!record) return;
    const startMs = this.options.now();
    this.options.uploadTexture(this.options.handleBase + record.slot, tile);
    measuredMs[0] = this.options.now() - startMs;
    record.state = READY;
    this.leaveActive(record);
  }

  private leaveActive(record: TileRecord): void {
    const at = this.active.indexOf(record);
    if (at >= 0) this.active.splice(at, 1);
  }
}

function closeImage(tile: DecodedTile): void {
  (tile.image as { close?: () => void }).close?.();
}

function grown(array: Float64Array<ArrayBuffer>): Float64Array<ArrayBuffer> {
  const next = new Float64Array(array.length * 2);
  next.set(array);
  return next;
}
