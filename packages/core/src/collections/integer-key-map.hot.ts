// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * @hotpath Looked up for every drawn tile every frame. A Map boxes number keys beyond 31 bits on every call, and surface
 * tile keys pass that from level 16 on (ADR 0018).
 * @benchmark benchmarks/run.ts
 */

const EMPTY = 0;
const USED = 1;
const MIN_CAPACITY = 16;

/**
 * A hash map from non-negative integer keys below 2^53 to values, with open addressing and linear probing over typed
 * arrays. The per-frame operations take the key as `keys[at]`, an element of an array the caller already holds, so no
 * double crosses a call boundary: a steady-state lookup or update allocates nothing. Growing allocates new tables, and
 * the single-key conveniences may box their argument; both belong outside the frame loop.
 */
export class IntegerKeyMap<V> {
  private keys = new Float64Array(0);
  private values: (V | undefined)[] = [];
  private states = new Uint8Array(0);
  private mask = 0;
  private count = 0;
  private readonly single = new Float64Array(1);

  constructor(initialCapacity = MIN_CAPACITY) {
    let capacity = MIN_CAPACITY;
    while (capacity < initialCapacity * 2) capacity *= 2;
    this.allocate(capacity);
  }

  /** Number of entries. */
  get size(): number {
    return this.count;
  }

  /** The value stored under `keys[at]`, or undefined. */
  getAt(keys: ArrayLike<number>, at: number): V | undefined {
    const slot = this.find(keys, at);
    return slot < 0 ? undefined : this.values[slot];
  }

  /** True when `keys[at]` is present. */
  hasAt(keys: ArrayLike<number>, at: number): boolean {
    return this.find(keys, at) >= 0;
  }

  /** Stores `value` under `keys[at]`, replacing any previous value. */
  setAt(keys: ArrayLike<number>, at: number, value: V): void {
    let slot = this.home(keys, at);
    const key = keys[at] ?? 0;
    while (this.states[slot] === USED) {
      if (this.keys[slot] === key) {
        this.values[slot] = value;
        return;
      }
      slot = (slot + 1) & this.mask;
    }
    if ((this.count + 1) * 2 > this.mask + 1) {
      this.grow();
      this.setAt(keys, at, value);
      return;
    }
    this.states[slot] = USED;
    this.keys[slot] = key;
    this.values[slot] = value;
    this.count++;
  }

  /** Removes `keys[at]`; returns the value it held, or undefined. */
  deleteAt(keys: ArrayLike<number>, at: number): V | undefined {
    let hole = this.find(keys, at);
    if (hole < 0) return undefined;
    const removed = this.values[hole];
    // Backward-shift deletion: later entries of the probe run move into the hole, so no tombstones accumulate.
    let slot = hole;
    for (;;) {
      slot = (slot + 1) & this.mask;
      if (this.states[slot] !== USED) break;
      const home = this.home(this.keys, slot);
      const stays = hole <= slot ? hole < home && home <= slot : hole < home || home <= slot;
      if (stays) continue;
      this.keys[hole] = this.keys[slot] ?? 0;
      this.values[hole] = this.values[slot];
      hole = slot;
    }
    this.states[hole] = EMPTY;
    this.values[hole] = undefined;
    this.count--;
    return removed;
  }

  /** The value stored under a key, or undefined (outside the frame loop: the key argument may be boxed). */
  get(key: number): V | undefined {
    this.single[0] = key;
    return this.getAt(this.single, 0);
  }

  /** True when a key is present (outside the frame loop). */
  has(key: number): boolean {
    this.single[0] = key;
    return this.hasAt(this.single, 0);
  }

  /** Stores a value under a key (outside the frame loop). */
  set(key: number, value: V): void {
    this.single[0] = key;
    this.setAt(this.single, 0, value);
  }

  /** Removes a key; returns the value it held (outside the frame loop). */
  delete(key: number): V | undefined {
    this.single[0] = key;
    return this.deleteAt(this.single, 0);
  }

  /** Removes every entry. */
  clear(): void {
    this.states.fill(EMPTY);
    this.values.fill(undefined);
    this.count = 0;
  }

  /** Calls `callback` for every entry, in no particular order; the map must not change meanwhile. */
  forEach(callback: (value: V, key: number) => void): void {
    for (let slot = 0; slot <= this.mask; slot++) {
      if (this.states[slot] === USED) callback(this.values[slot] as V, this.keys[slot] ?? 0);
    }
  }

  /** The slot holding `keys[at]`, or -1. */
  private find(keys: ArrayLike<number>, at: number): number {
    let slot = this.home(keys, at);
    const key = keys[at] ?? 0;
    while (this.states[slot] === USED) {
      if (this.keys[slot] === key) return slot;
      slot = (slot + 1) & this.mask;
    }
    return -1;
  }

  /**
   * The first slot probed for `keys[at]`: a multiplicative hash of the key's 32-bit halves. The product of a 32-bit
   * value and a 16-bit constant is exact in a double, and `>>> 0` keeps its low 32 bits; Math.imul would be a builtin
   * call with boxed arguments in code not yet fully optimized.
   */
  private home(keys: ArrayLike<number>, at: number): number {
    const key = keys[at] ?? 0;
    const low = key >>> 0;
    const high = (key / 4294967296) >>> 0;
    let hash = (((low ^ (high * 40503)) >>> 0) * 40503) >>> 0;
    hash ^= hash >>> 15;
    hash = ((hash >>> 0) * 40503) >>> 0;
    hash ^= hash >>> 13;
    return hash & this.mask;
  }

  /** Empty tables of `capacity` slots (a power of two). */
  private allocate(capacity: number): void {
    this.keys = new Float64Array(capacity);
    this.values = new Array<V | undefined>(capacity).fill(undefined);
    this.states = new Uint8Array(capacity);
    this.mask = capacity - 1;
    this.count = 0;
  }

  private grow(): void {
    const { keys, values, states } = this;
    this.allocate((this.mask + 1) * 2);
    for (let slot = 0; slot < states.length; slot++) {
      if (states[slot] === USED) this.setAt(keys, slot, values[slot] as V);
    }
  }
}
