// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * @hotpath Drained every frame while tiles arrive; a binary heap over typed
 * arrays with tile keys and priorities read from arrays the caller holds, so the frame path allocates nothing
 * (ADR 0018).
 * @benchmark benchmarks/run.ts
 */
import { IntegerKeyMap } from '../collections/integer-key-map.hot.js';
import type { DecodedTile } from '../scheduler/types.js';
import { UploadCostModel } from './upload-cost.js';
import { grownArray } from '../collections/typed-arrays.js';

/** Per-frame upload limits (ADR 0007 §Uploads, `docs/internal/plan/quality.md`). */
export interface UploadBudget {
  /** Predicted milliseconds of upload work per frame. */
  readonly maxMs: number;
  /** Bytes uploaded per frame. */
  readonly maxBytes: number;
}

/** The budget of `docs/internal/plan/quality.md`: 2 ms and 8 MB (8,000,000 bytes, the stricter reading of "MB") per frame. */
export const DEFAULT_UPLOAD_BUDGET: UploadBudget = Object.freeze({ maxMs: 2, maxBytes: 8_000_000 });

/** Written into `measuredMs[0]` by an upload function that did not upload the tile (a refused admission). */
export const UPLOAD_REFUSED = -2;

/**
 * Uploads one tile to the GPU and writes how long it took, in milliseconds, into `measuredMs[0]`; it leaves the value
 * negative when it cannot measure, and the prediction stands in for it, or writes {@link UPLOAD_REFUSED} when it did
 * not upload the tile. It must not change the queue while it runs.
 */
export type UploadFunction<T extends DecodedTile> = (tile: T, measuredMs: Float64Array) => void;

/** Settings of an {@link UploadQueue}. */
export interface UploadQueueOptions<T extends DecodedTile> {
  /** Performs one upload (the renderer backend's `initTexture` path). */
  upload: UploadFunction<T>;
  /** The cost model of the backend; a new one with the default seeds when omitted. */
  costModel?: UploadCostModel;
  /** Entries to allocate room for up front; the tables grow on a slow path beyond it. */
  initialCapacity?: number;
}

/** Indices of the double-valued state, kept in a typed array rather than in fields (ADR 0018). */
const PENDING_BYTES = 0;
const DRAIN_MS = 1;
const DRAIN_BYTES = 2;
const UPLOADED = 3;
const SEQUENCE = 4;

const NONE = -1;
const DEFAULT_CAPACITY = 64;

/**
 * Decoded tiles waiting for GPU upload, in priority order (lower first, ADR 0007's key; ties in arrival order). Each
 * frame {@link drain} uploads from the front while the predicted time and the bytes fit the budget, and always uploads
 * at least one tile, so a tile larger than the budget never starves. Predictions come from the backend's
 * {@link UploadCostModel}, which every measured upload refines.
 *
 * Entries are keyed by tile key. The `*At` methods read keys and priorities as `keys[at]` and `priorities[at]` from
 * arrays the caller holds (the tile table's columns), so no double crosses a call boundary in the frame loop; the
 * single-key forms may box their arguments and belong outside it.
 */
export class UploadQueue<T extends DecodedTile> {
  /** The cost model predicting upload times. */
  readonly costModel: UploadCostModel;
  private readonly upload: UploadFunction<T>;
  private readonly map: IntegerKeyMap<number>;
  private keys: Float64Array;
  private priorities: Float64Array;
  private sequences: Float64Array;
  private compressed: Uint8Array;
  private heapIndex: Int32Array;
  private freeNext: Int32Array;
  private tiles: (T | undefined)[];
  private heap: Int32Array;
  private heapSize = 0;
  private freeHead = NONE;
  private readonly state = new Float64Array(5);
  private readonly measuredMs = new Float64Array(1);
  private readonly singleKey = new Float64Array(1);
  private readonly singlePriority = new Float64Array(1);

  constructor(options: UploadQueueOptions<T>) {
    const capacity = options.initialCapacity ?? DEFAULT_CAPACITY;
    if (!(capacity >= 1)) throw new RangeError(`initialCapacity must be at least 1, got ${capacity}`);
    this.upload = options.upload;
    this.costModel = options.costModel ?? new UploadCostModel();
    this.map = new IntegerKeyMap<number>(capacity);
    this.keys = new Float64Array(capacity);
    this.priorities = new Float64Array(capacity);
    this.sequences = new Float64Array(capacity);
    this.compressed = new Uint8Array(capacity);
    this.heapIndex = new Int32Array(capacity);
    this.freeNext = new Int32Array(capacity);
    this.tiles = new Array<T | undefined>(capacity).fill(undefined);
    this.heap = new Int32Array(capacity);
    this.chainFree(0, capacity);
  }

  /** Tiles waiting. */
  get size(): number {
    return this.heapSize;
  }

  /** GPU bytes of the tiles waiting: decoded but not uploaded (ADR 0007's backpressure reads it). */
  get pendingBytes(): number {
    return this.state[PENDING_BYTES] ?? 0;
  }

  /** Milliseconds the last {@link drain} spent, as measured (predicted where an upload was not measured). */
  get lastDrainMs(): number {
    return this.state[DRAIN_MS] ?? 0;
  }

  /** Bytes the last {@link drain} uploaded. */
  get lastDrainBytes(): number {
    return this.state[DRAIN_BYTES] ?? 0;
  }

  /** Tiles uploaded since the queue was created. */
  get uploadedCount(): number {
    return this.state[UPLOADED] ?? 0;
  }

  /**
   * Queues `tile` under `keys[at]` with priority `priorities[at]`. A key already waiting gets the new tile and
   * priority; the tile it replaces, if a different one, is returned so the caller can release it (close its bitmap),
   * otherwise undefined.
   */
  enqueueAt(
    keys: ArrayLike<number>,
    priorities: ArrayLike<number>,
    at: number,
    tile: T,
    compressed: boolean,
  ): T | undefined {
    let slot = this.map.getAt(keys, at);
    let replaced: T | undefined;
    if (slot === undefined) {
      slot = this.insert(keys, at);
    } else {
      replaced = this.tiles[slot];
      this.state[PENDING_BYTES] = (this.state[PENDING_BYTES] ?? 0) - (replaced?.gpuBytes ?? 0);
    }
    this.tiles[slot] = tile;
    this.compressed[slot] = compressed ? 1 : 0;
    this.state[PENDING_BYTES] = (this.state[PENDING_BYTES] ?? 0) + tile.gpuBytes;
    this.priorities[slot] = priorities[at] ?? 0;
    this.restore(slot);
    return replaced === tile ? undefined : replaced;
  }

  /** {@link enqueueAt} for a single key (outside the frame loop). */
  enqueue(key: number, priority: number, tile: T, compressed: boolean): T | undefined {
    this.singleKey[0] = key;
    this.singlePriority[0] = priority;
    return this.enqueueAt(this.singleKey, this.singlePriority, 0, tile, compressed);
  }

  /** Removes `keys[at]` (a tile no longer wanted) and returns its tile for the caller to release, or undefined. */
  removeAt(keys: ArrayLike<number>, at: number): T | undefined {
    const slot = this.map.deleteAt(keys, at);
    if (slot === undefined) return undefined;
    this.heapRemove(this.heapIndex[slot] ?? 0);
    return this.free(slot);
  }

  /** {@link removeAt} for a single key (outside the frame loop). */
  remove(key: number): T | undefined {
    this.singleKey[0] = key;
    return this.removeAt(this.singleKey, 0);
  }

  /**
   * Uploads waiting tiles in priority order while the time spent plus the next tile's predicted time stays within
   * `budget.maxMs` and the bytes within `budget.maxBytes`; the first tile of every drain is uploaded regardless, so
   * nothing starves. Stops at the first tile that does not fit, so a lower priority never overtakes. Returns the
   * number of tiles uploaded.
   */
  drain(budget: UploadBudget = DEFAULT_UPLOAD_BUDGET): number {
    const state = this.state;
    const rates = this.costModel.msPerByte;
    const measured = this.measuredMs;
    state[DRAIN_MS] = 0;
    state[DRAIN_BYTES] = 0;
    let count = 0;
    while (this.heapSize > 0) {
      const slot = this.heap[0] ?? 0;
      const tile = this.tiles[slot] as T;
      const bytes = tile.gpuBytes;
      const kind = this.compressed[slot] ?? 0;
      const predictedMs = bytes * (rates[kind] ?? 0);
      if (
        count > 0 &&
        ((state[DRAIN_MS] ?? 0) + predictedMs > budget.maxMs || (state[DRAIN_BYTES] ?? 0) + bytes > budget.maxBytes)
      ) {
        break;
      }
      this.heapRemove(0);
      this.map.deleteAt(this.keys, slot);
      this.free(slot);
      measured[0] = -1;
      this.upload(tile, measured);
      const ms = measured[0] ?? -1;
      // Refused by the memory budget: nothing reached the GPU, so neither time, bytes nor the upload count.
      if (ms === UPLOAD_REFUSED) continue;
      if (ms >= 0) {
        this.costModel.recordAt(bytes, measured, 0, kind === 1);
        state[DRAIN_MS] = (state[DRAIN_MS] ?? 0) + ms;
      } else {
        state[DRAIN_MS] = (state[DRAIN_MS] ?? 0) + predictedMs;
      }
      state[DRAIN_BYTES] = (state[DRAIN_BYTES] ?? 0) + bytes;
      count++;
    }
    state[UPLOADED] = (state[UPLOADED] ?? 0) + count;
    return count;
  }

  /** Removes every waiting tile, passing each to `release` (to close its bitmap). */
  clear(release?: (tile: T) => void): void {
    while (this.heapSize > 0) {
      const slot = this.heap[0] ?? 0;
      this.heapRemove(0);
      this.map.deleteAt(this.keys, slot);
      const tile = this.free(slot);
      if (tile !== undefined) release?.(tile);
    }
  }

  private insert(keys: ArrayLike<number>, at: number): number {
    if (this.freeHead === NONE) this.grow();
    const slot = this.freeHead;
    this.freeHead = this.freeNext[slot] ?? NONE;
    this.keys[slot] = keys[at] ?? 0;
    const sequence = this.state[SEQUENCE] ?? 0;
    this.sequences[slot] = sequence;
    this.state[SEQUENCE] = sequence + 1;
    this.heap[this.heapSize] = slot;
    this.heapIndex[slot] = this.heapSize;
    this.heapSize++;
    this.map.setAt(keys, at, slot);
    return slot;
  }

  /** Returns a slot (already out of the map and the heap) to the free list; gives back its tile. */
  private free(slot: number): T | undefined {
    const tile = this.tiles[slot];
    this.tiles[slot] = undefined;
    this.state[PENDING_BYTES] = (this.state[PENDING_BYTES] ?? 0) - (tile?.gpuBytes ?? 0);
    this.freeNext[slot] = this.freeHead;
    this.freeHead = slot;
    return tile;
  }

  /** True when slot `a` goes before slot `b`. */
  private before(a: number, b: number): boolean {
    const pa = this.priorities[a] ?? 0;
    const pb = this.priorities[b] ?? 0;
    return pa < pb || (pa === pb && (this.sequences[a] ?? 0) < (this.sequences[b] ?? 0));
  }

  /** Moves a slot whose priority changed to its place in the heap. */
  private restore(slot: number): void {
    const index = this.heapIndex[slot] ?? 0;
    this.siftUp(index);
    this.siftDown(this.heapIndex[slot] ?? 0);
  }

  /** Removes the heap element at `index`. */
  private heapRemove(index: number): void {
    this.heapSize--;
    if (index === this.heapSize) return;
    const last = this.heap[this.heapSize] ?? 0;
    this.heap[index] = last;
    this.heapIndex[last] = index;
    this.restore(last);
  }

  private siftUp(start: number): void {
    const heap = this.heap;
    const slot = heap[start] ?? 0;
    let index = start;
    while (index > 0) {
      const parentIndex = (index - 1) >> 1;
      const parent = heap[parentIndex] ?? 0;
      if (!this.before(slot, parent)) break;
      heap[index] = parent;
      this.heapIndex[parent] = index;
      index = parentIndex;
    }
    heap[index] = slot;
    this.heapIndex[slot] = index;
  }

  private siftDown(start: number): void {
    const heap = this.heap;
    const slot = heap[start] ?? 0;
    let index = start;
    for (;;) {
      const left = index * 2 + 1;
      if (left >= this.heapSize) break;
      const right = left + 1;
      let child = heap[left] ?? 0;
      let childIndex = left;
      if (right < this.heapSize && this.before(heap[right] ?? 0, child)) {
        child = heap[right] ?? 0;
        childIndex = right;
      }
      if (!this.before(child, slot)) break;
      heap[index] = child;
      this.heapIndex[child] = index;
      index = childIndex;
    }
    heap[index] = slot;
    this.heapIndex[slot] = index;
  }

  /** Links slots `from` to `to - 1` into the free list. */
  private chainFree(from: number, to: number): void {
    for (let slot = to - 1; slot >= from; slot--) {
      this.freeNext[slot] = this.freeHead;
      this.freeHead = slot;
    }
  }

  /** Doubles the tables: a slow path, once per doubling of the waiting count. */
  private grow(): void {
    const capacity = this.keys.length;
    const grown = capacity * 2;
    this.keys = grownArray(this.keys, grown);
    this.priorities = grownArray(this.priorities, grown);
    this.sequences = grownArray(this.sequences, grown);
    this.compressed = grownArray(this.compressed, grown);
    this.heapIndex = grownArray(this.heapIndex, grown);
    this.freeNext = grownArray(this.freeNext, grown);
    this.heap = grownArray(this.heap, grown);
    for (let slot = capacity; slot < grown; slot++) this.tiles.push(undefined);
    this.chainFree(capacity, grown);
  }
}
