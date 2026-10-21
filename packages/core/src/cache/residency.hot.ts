/**
 * @hotpath Touched for every selected and every drawn tile each frame, and trimmed each frame; doubles stay in typed
 * arrays and tile keys are read from arrays the caller holds, so the frame path allocates nothing (ADR 0018).
 * @benchmark benchmarks/run.ts
 */
import { IntegerKeyMap } from '../collections/integer-key-map.hot.js';

/** Never evicted: the pinned base (F084). Pinned entries are kept out of the LRU list altogether. */
const PINNED = 1;
/** Never evicted: pipeline work for the tile is in progress (ADR 0007 §Protected tiles). */
const BUSY = 2;

/** Indices of the double-valued state, kept in a typed array rather than in fields (ADR 0018). */
const USED = 0;
const BUDGET = 1;
const FRAME = 2;
const LOW_WATER = 3;
const REFUSED = 4;
const EVICTED = 5;
const START_MS = 6;

const NONE = -1;
const DEFAULT_CAPACITY = 256;

/** Default fraction of the budget a trim goes down to once eviction has started (ADR 0007 §Trimming). */
export const DEFAULT_LOW_WATER_RATIO = 0.9;

/** Settings of a {@link Residency}. */
export interface ResidencyOptions {
  /** The hard cap, in bytes; usage never exceeds it. */
  budgetBytes: number;
  /** Fraction of the budget a trim goes down to once eviction has started, in [0, 1] (default 0.9). */
  lowWaterRatio?: number;
  /**
   * Called with the key of every evicted entry, after the entry is gone; it releases the tile's resources. It must not
   * change this residency (admit, release, pin) while it runs.
   */
  onEvict?: (key: number) => void;
  /** A millisecond clock, needed only when trims are given a time limit. */
  nowMs?: () => number;
  /** Entries to allocate room for up front; the tables grow on a slow path beyond it. */
  initialCapacity?: number;
}

function invalidBytes(name: string, bytes: number): never {
  throw new RangeError(`${name} must be a non-negative integer, got ${bytes}`);
}

/**
 * Byte-accounted residency of tiles in one memory tier (ADR 0007 §Memory): one instance for GPU memory, one for RAM.
 * Each entry holds a tile key, its bytes, the frame it was last used and its protections.
 *
 * - **LRU order:** an intrusive doubly linked list over the entry slots, least recently used first. {@link touch} moves
 *   an entry to the end, so touching in post-order keeps parents more recent than their children.
 * - **Frame marker:** entries used in the current frame (the latest frame passed to any method) are never evicted.
 * - **Protection:** pinned entries ({@link setPinned}, F084), entries drawn in the current frame ({@link markDrawn},
 *   F098) and busy entries ({@link setBusy}) are never evicted either.
 * - **Admission:** {@link admit} accounts the bytes of an entry before they are spent, evicting the least recently used
 *   unprotected entries just enough to make room, and refuses rather than overrun the budget when that cannot be done.
 * - **Trimming:** once an admission needed room, or the budget was lowered below usage, {@link trim} evicts per frame,
 *   within an entry and a time limit, down to the low-water mark.
 *
 * The `*At` methods read the key as `keys[at]` from an array the caller holds, so no double crosses a call boundary in
 * the frame loop; the single-key forms may box their argument and belong outside it. Evictions call `onEvict` with the
 * key and may allocate, as any eviction may (ADR 0018).
 */
export class Residency {
  private readonly map: IntegerKeyMap<number>;
  private keys: Float64Array;
  private entryBytes: Float64Array;
  private lastUsed: Float64Array;
  private drawnFrame: Float64Array;
  private prev: Int32Array;
  private next: Int32Array;
  private flags: Uint8Array;
  private head = NONE;
  private tail = NONE;
  private freeHead = NONE;
  private trimming = false;
  private readonly state = new Float64Array(7);
  private readonly single = new Float64Array(1);
  private readonly onEvict: ((key: number) => void) | undefined;
  private readonly nowMs: (() => number) | undefined;

  constructor(options: ResidencyOptions) {
    const capacity = options.initialCapacity ?? DEFAULT_CAPACITY;
    if (!(capacity >= 1)) throw new RangeError(`initialCapacity must be at least 1, got ${capacity}`);
    const lowWater = options.lowWaterRatio ?? DEFAULT_LOW_WATER_RATIO;
    if (!(lowWater >= 0 && lowWater <= 1)) throw new RangeError(`lowWaterRatio must be in [0, 1], got ${lowWater}`);
    this.map = new IntegerKeyMap<number>(capacity);
    this.keys = new Float64Array(capacity);
    this.entryBytes = new Float64Array(capacity);
    this.lastUsed = new Float64Array(capacity);
    this.drawnFrame = new Float64Array(capacity);
    this.prev = new Int32Array(capacity);
    this.next = new Int32Array(capacity);
    this.flags = new Uint8Array(capacity);
    this.chainFree(0, capacity);
    this.state[LOW_WATER] = lowWater;
    this.setBudget(options.budgetBytes);
    this.onEvict = options.onEvict;
    this.nowMs = options.nowMs;
  }

  /** Bytes accounted to resident entries, reservations included. */
  get usedBytes(): number {
    return this.state[USED] ?? 0;
  }

  /** The hard cap, in bytes. */
  get budgetBytes(): number {
    return this.state[BUDGET] ?? 0;
  }

  /** Number of resident entries. */
  get size(): number {
    return this.map.size;
  }

  /** The current frame: the latest frame passed to {@link touch}, {@link markDrawn} or {@link trim}. */
  get currentFrame(): number {
    return this.state[FRAME] ?? 0;
  }

  /** Admissions refused because protected entries left no room. */
  get refusedCount(): number {
    return this.state[REFUSED] ?? 0;
  }

  /** Entries evicted so far. */
  get evictedCount(): number {
    return this.state[EVICTED] ?? 0;
  }

  /**
   * Changes the budget. Usage above a lowered budget is evicted by the following trims, and admissions evict until
   * they fit under it (the WebGPU out-of-memory path lowers the budget, ADR 0007).
   */
  setBudget(bytes: number): void {
    if (!(bytes >= 0) || bytes % 1 !== 0) invalidBytes('budgetBytes', bytes);
    this.state[BUDGET] = bytes;
    if ((this.state[USED] ?? 0) > bytes) this.trimming = true;
  }

  /** Marks `keys[at]` as used in `frame`, moving it to the most recently used end; false when it is not resident. */
  touchAt(keys: ArrayLike<number>, at: number, frame: number): boolean {
    const slot = this.map.getAt(keys, at);
    if (slot === undefined) return false;
    this.advance(frame);
    this.lastUsed[slot] = this.state[FRAME] ?? 0;
    if (((this.flags[slot] ?? 0) & PINNED) === 0 && slot !== this.tail) {
      this.unlink(slot);
      this.linkTail(slot);
    }
    return true;
  }

  /** {@link touchAt} for a single key (outside the frame loop). */
  touch(key: number, frame: number): boolean {
    this.single[0] = key;
    return this.touchAt(this.single, 0, frame);
  }

  /**
   * Marks `keys[at]` as drawn in `frame`: protected from eviction until a later frame begins. It does not change the
   * LRU order; the selection touches tiles separately. False when the key is not resident.
   */
  markDrawnAt(keys: ArrayLike<number>, at: number, frame: number): boolean {
    const slot = this.map.getAt(keys, at);
    if (slot === undefined) return false;
    this.advance(frame);
    this.drawnFrame[slot] = frame;
    return true;
  }

  /** {@link markDrawnAt} for a single key (outside the frame loop). */
  markDrawn(key: number, frame: number): boolean {
    this.single[0] = key;
    return this.markDrawnAt(this.single, 0, frame);
  }

  /**
   * Accounts `bytes` to `keys[at]`: a new entry (most recently used, in the current frame) or a new size for a resident
   * one, which reconciles a reservation with the size that arrived. When usage would exceed the budget, the least
   * recently used unprotected entries are evicted just enough to make room, and trimming starts. If even evicting
   * every unprotected entry could not make room, nothing is evicted or changed, the refusal is counted and the result
   * is false: the caller keeps drawing resident ancestors and coarsens the selection.
   */
  admitAt(keys: ArrayLike<number>, at: number, bytes: number): boolean {
    if (!(bytes >= 0) || bytes % 1 !== 0) invalidBytes('bytes', bytes);
    let slot = this.map.getAt(keys, at);
    const old = slot === undefined ? 0 : (this.entryBytes[slot] ?? 0);
    const state = this.state;
    if ((state[USED] ?? 0) - old + bytes > (state[BUDGET] ?? 0)) {
      if (!this.makeRoom(slot === undefined ? NONE : slot, bytes - old)) {
        state[REFUSED] = (state[REFUSED] ?? 0) + 1;
        this.trimming = true;
        return false;
      }
      this.trimming = true;
    }
    if (slot === undefined) slot = this.insert(keys, at);
    this.entryBytes[slot] = bytes;
    state[USED] = (state[USED] ?? 0) + (bytes - old);
    return true;
  }

  /** {@link admitAt} for a single key (outside the frame loop). */
  admit(key: number, bytes: number): boolean {
    this.single[0] = key;
    return this.admitAt(this.single, 0, bytes);
  }

  /** Removes `keys[at]` and its bytes without calling `onEvict` (the caller released it); false when absent. */
  releaseAt(keys: ArrayLike<number>, at: number): boolean {
    const slot = this.map.deleteAt(keys, at);
    if (slot === undefined) return false;
    this.remove(slot);
    return true;
  }

  /** {@link releaseAt} for a single key (outside the frame loop). */
  release(key: number): boolean {
    this.single[0] = key;
    return this.releaseAt(this.single, 0);
  }

  /** True when the key is resident (outside the frame loop). */
  has(key: number): boolean {
    return this.map.has(key);
  }

  /** The bytes accounted to a key, or undefined when it is not resident (outside the frame loop). */
  bytesOf(key: number): number | undefined {
    const slot = this.map.get(key);
    return slot === undefined ? undefined : this.entryBytes[slot];
  }

  /**
   * Pins or unpins a resident key. A pinned entry is never evicted (the pinned base, F084); an unpinned one rejoins the
   * LRU order as used in the current frame. False when the key is not resident.
   */
  setPinned(key: number, pinned: boolean): boolean {
    const slot = this.map.get(key);
    if (slot === undefined) return false;
    const flags = this.flags[slot] ?? 0;
    if (pinned && (flags & PINNED) === 0) {
      this.unlink(slot);
      this.flags[slot] = flags | PINNED;
    } else if (!pinned && (flags & PINNED) !== 0) {
      this.flags[slot] = flags & ~PINNED;
      this.lastUsed[slot] = this.state[FRAME] ?? 0;
      this.linkTail(slot);
    }
    return true;
  }

  /**
   * Starts a frame: from now on only what this frame touches or draws is protected by the frame marker, so admissions
   * made before the frame's first touch may evict what only the previous frame used.
   */
  startFrame(frame: number): void {
    this.advance(frame);
  }

  /**
   * True when a resident key may not be evicted now: pinned, busy, or touched or drawn in the current frame (outside
   * the frame loop). The RAM tier asks it before dropping a tile's bytes, which would drop its GPU copy too.
   */
  isKept(key: number): boolean {
    const slot = this.map.get(key);
    if (slot === undefined) return false;
    return (
      ((this.flags[slot] ?? 0) & PINNED) !== 0 || this.isProtected(slot) || this.lastUsed[slot] === this.state[FRAME]
    );
  }

  /** True when a resident key is pinned. */
  isPinned(key: number): boolean {
    const slot = this.map.get(key);
    return slot !== undefined && ((this.flags[slot] ?? 0) & PINNED) !== 0;
  }

  /**
   * Marks a resident key busy (pipeline work in progress: decoding, waiting for upload) or no longer busy; a busy entry
   * is never evicted. False when the key is not resident.
   */
  setBusy(key: number, busy: boolean): boolean {
    const slot = this.map.get(key);
    if (slot === undefined) return false;
    const flags = this.flags[slot] ?? 0;
    this.flags[slot] = busy ? flags | BUSY : flags & ~BUSY;
    return true;
  }

  /**
   * Starts `frame` if it is newer and, while trimming (an admission needed room, or usage exceeds a lowered budget),
   * evicts least recently used unprotected entries down to the low-water mark, at most `maxEntries` of them and, when
   * `maxMs` is given and a clock was configured, for at most about `maxMs` milliseconds. Entries used in the current
   * frame stop the walk (frame marker). Returns the number of entries evicted; without trimming to do, it returns 0
   * at once.
   */
  trim(frame: number, maxEntries: number, maxMs?: number): number {
    this.advance(frame);
    if ((this.state[USED] ?? 0) > (this.state[BUDGET] ?? 0)) this.trimming = true;
    if (!this.trimming) return 0;
    return this.trimToLowWater(maxEntries, maxMs);
  }

  /** The eviction walk of {@link trim}, kept apart so the per-frame call stays small (ADR 0018, cold paths). */
  private trimToLowWater(maxEntries: number, maxMs: number | undefined): number {
    const state = this.state;
    // The clock is read from the first eviction on: a trim blocked by protected entries, which may repeat every frame
    // until the frame marker moves past them, reads no clock and so boxes no double.
    const clock = maxMs === undefined ? undefined : this.nowMs;
    const lowWater = (state[BUDGET] ?? 0) * (state[LOW_WATER] ?? 0);
    let evicted = 0;
    let slot = this.head;
    while (slot !== NONE && evicted < maxEntries && (state[USED] ?? 0) > lowWater) {
      if ((this.lastUsed[slot] ?? 0) >= (state[FRAME] ?? 0)) break;
      const following = this.next[slot] ?? NONE;
      if (!this.isProtected(slot)) {
        if (clock !== undefined && evicted === 0) state[START_MS] = clock();
        this.evict(slot);
        evicted++;
        if (clock !== undefined && maxMs !== undefined && clock() - (state[START_MS] ?? 0) >= maxMs) break;
      }
      slot = following;
    }
    if ((state[USED] ?? 0) <= lowWater) this.trimming = false;
    return evicted;
  }

  /**
   * Evicts least recently used unprotected entries, other than `exclude`, until `deltaBytes` more fit in the budget;
   * evicts nothing and returns false when the evictable entries are not enough.
   */
  private makeRoom(exclude: number, deltaBytes: number): boolean {
    const state = this.state;
    const needed = (state[USED] ?? 0) + deltaBytes - (state[BUDGET] ?? 0);
    let available = 0;
    for (let slot = this.head; slot !== NONE && available < needed; slot = this.next[slot] ?? NONE) {
      if ((this.lastUsed[slot] ?? 0) >= (state[FRAME] ?? 0)) break;
      if (slot !== exclude && !this.isProtected(slot)) available += this.entryBytes[slot] ?? 0;
    }
    if (available < needed) return false;
    let freed = 0;
    let slot = this.head;
    while (slot !== NONE && freed < needed) {
      const following = this.next[slot] ?? NONE;
      if (slot !== exclude && !this.isProtected(slot)) {
        freed += this.entryBytes[slot] ?? 0;
        this.evict(slot);
      }
      slot = following;
    }
    return true;
  }

  /** True when an entry in the LRU list may not be evicted: drawn in the current frame, or busy. */
  private isProtected(slot: number): boolean {
    return ((this.flags[slot] ?? 0) & BUSY) !== 0 || this.drawnFrame[slot] === this.state[FRAME];
  }

  private advance(frame: number): void {
    if (frame > (this.state[FRAME] ?? 0)) this.state[FRAME] = frame;
  }

  private evict(slot: number): void {
    this.map.deleteAt(this.keys, slot);
    this.remove(slot);
    this.state[EVICTED] = (this.state[EVICTED] ?? 0) + 1;
    this.onEvict?.(this.keys[slot] ?? 0);
  }

  /** Unlinks a slot already deleted from the map, returns its bytes and puts it on the free list. */
  private remove(slot: number): void {
    if (((this.flags[slot] ?? 0) & PINNED) === 0) this.unlink(slot);
    this.state[USED] = (this.state[USED] ?? 0) - (this.entryBytes[slot] ?? 0);
    this.entryBytes[slot] = 0;
    this.flags[slot] = 0;
    this.next[slot] = this.freeHead;
    this.freeHead = slot;
  }

  private insert(keys: ArrayLike<number>, at: number): number {
    if (this.freeHead === NONE) this.grow();
    const slot = this.freeHead;
    this.freeHead = this.next[slot] ?? NONE;
    this.keys[slot] = keys[at] ?? 0;
    this.entryBytes[slot] = 0;
    this.lastUsed[slot] = this.state[FRAME] ?? 0;
    this.drawnFrame[slot] = NONE;
    this.flags[slot] = 0;
    this.linkTail(slot);
    this.map.setAt(keys, at, slot);
    return slot;
  }

  private linkTail(slot: number): void {
    this.prev[slot] = this.tail;
    this.next[slot] = NONE;
    if (this.tail === NONE) this.head = slot;
    else this.next[this.tail] = slot;
    this.tail = slot;
  }

  private unlink(slot: number): void {
    const before = this.prev[slot] ?? NONE;
    const after = this.next[slot] ?? NONE;
    if (before === NONE) this.head = after;
    else this.next[before] = after;
    if (after === NONE) this.tail = before;
    else this.prev[after] = before;
  }

  /** Links slots `from` to `to - 1` into the free list. */
  private chainFree(from: number, to: number): void {
    for (let slot = to - 1; slot >= from; slot--) {
      this.next[slot] = this.freeHead;
      this.freeHead = slot;
    }
  }

  /** Doubles the tables: a slow path, once per doubling of the resident count. */
  private grow(): void {
    const capacity = this.keys.length;
    const grown = capacity * 2;
    this.keys = copyFloat64(this.keys, grown);
    this.entryBytes = copyFloat64(this.entryBytes, grown);
    this.lastUsed = copyFloat64(this.lastUsed, grown);
    this.drawnFrame = copyFloat64(this.drawnFrame, grown);
    const prev = new Int32Array(grown);
    prev.set(this.prev);
    this.prev = prev;
    const next = new Int32Array(grown);
    next.set(this.next);
    this.next = next;
    const flags = new Uint8Array(grown);
    flags.set(this.flags);
    this.flags = flags;
    this.chainFree(capacity, grown);
  }
}

function copyFloat64(source: Float64Array, length: number): Float64Array {
  const copy = new Float64Array(length);
  copy.set(source);
  return copy;
}
