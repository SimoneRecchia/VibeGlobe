/**
 * @hotpath Rebuilt and drained every frame over every queued tile request (ADR 0007: heapify, drop, dispatch); a
 * priority passed as a call argument would be boxed in code V8 did not inline, so priorities are read from typed arrays
 * (ADR 0018).
 * @benchmark benchmarks/run.ts
 */

const MIN_CAPACITY = 16;
const ABSENT = -1;

/**
 * A binary min-heap of record indices (non-negative integers) ordered by priority, lower first; equal priorities pop
 * in ascending record index, so the order is deterministic. A NaN priority counts as +Infinity.
 *
 * Priorities are passed as `priorities[at]`, an element of a typed array the caller already holds (the tile table's
 * priority column), so no double crosses a call boundary. Every operation allocates nothing once the heap has grown to
 * the working set: the heap and the index-to-position table grow by doubling on a separate slow path.
 *
 * Two ways to fill it: {@link PriorityHeap.pushAt} keeps the heap ordered after every insertion (O(log n)), while
 * {@link PriorityHeap.appendAt} followed by one {@link PriorityHeap.heapify} rebuilds it in O(n), which is how the
 * scheduler rebuilds its queue each frame.
 */
export class PriorityHeap {
  /** Record index at each heap position. */
  private items: Int32Array;
  /** Priority at each heap position, kept beside `items` for locality. */
  private keys: Float64Array;
  /** Heap position of each record index, or -1 when the record is not in the heap. */
  private positions: Int32Array;
  private count = 0;
  /** False after {@link PriorityHeap.appendAt} until the next {@link PriorityHeap.heapify}. */
  private ordered = true;
  private readonly single = new Float64Array(1);

  /**
   * @param initialCapacity - Expected number of queued records.
   * @param initialRecordCapacity - Expected largest record index plus one.
   */
  constructor(initialCapacity = MIN_CAPACITY, initialRecordCapacity = MIN_CAPACITY) {
    const capacity = initialCapacity > MIN_CAPACITY ? initialCapacity : MIN_CAPACITY;
    const records = initialRecordCapacity > MIN_CAPACITY ? initialRecordCapacity : MIN_CAPACITY;
    this.items = new Int32Array(capacity);
    this.keys = new Float64Array(capacity);
    this.positions = new Int32Array(records).fill(ABSENT);
  }

  /** Number of records in the heap. */
  get size(): number {
    return this.count;
  }

  /** True when the record index is in the heap. */
  has(index: number): boolean {
    return index >= 0 && index < this.positions.length && this.positions[index] !== ABSENT;
  }

  /** The record index with the lowest priority, without removing it, or -1 when empty. */
  peek(): number {
    if (this.count === 0) return ABSENT;
    if (!this.ordered) this.heapify();
    return this.items[0] ?? ABSENT;
  }

  /**
   * Inserts record `index` with priority `priorities[at]`, or changes its priority when it is already in the heap.
   * `index` must be a non-negative integer.
   */
  pushAt(index: number, priorities: ArrayLike<number>, at: number): void {
    if (!this.ordered) this.heapify();
    if (this.has(index)) {
      this.updateAt(index, priorities, at);
      return;
    }
    const position = this.place(index, priorities, at);
    this.siftUp(position);
  }

  /**
   * Inserts record `index` with priority `priorities[at]` without restoring the heap order; call
   * {@link PriorityHeap.heapify} after the last append (other operations heapify first if needed). A record already in
   * the heap only has its priority replaced.
   */
  appendAt(index: number, priorities: ArrayLike<number>, at: number): void {
    if (this.has(index)) {
      const priority = priorities[at] ?? Infinity;
      this.keys[this.positions[index] ?? 0] = priority === priority ? priority : Infinity;
    } else {
      this.place(index, priorities, at);
    }
    this.ordered = false;
  }

  /** Restores the heap order in O(n) after {@link PriorityHeap.appendAt}. */
  heapify(): void {
    for (let position = (this.count >> 1) - 1; position >= 0; position--) this.siftDown(position);
    this.ordered = true;
  }

  /** Removes and returns the record index with the lowest priority, or -1 when empty. */
  pop(): number {
    if (this.count === 0) return ABSENT;
    if (!this.ordered) this.heapify();
    const top = this.items[0] ?? ABSENT;
    this.removeAtPosition(0);
    return top;
  }

  /** Removes record `index`; returns false when it was not in the heap. */
  remove(index: number): boolean {
    if (!this.has(index)) return false;
    if (!this.ordered) this.heapify();
    this.removeAtPosition(this.positions[index] ?? 0);
    return true;
  }

  /** Sets the priority of record `index` to `priorities[at]`; returns false (and does nothing) when it is absent. */
  updateAt(index: number, priorities: ArrayLike<number>, at: number): boolean {
    if (!this.has(index)) return false;
    if (!this.ordered) this.heapify();
    const position = this.positions[index] ?? 0;
    const previous = this.keys[position] ?? 0;
    const given = priorities[at] ?? Infinity;
    const next = given === given ? given : Infinity;
    this.keys[position] = next;
    if (next < previous) this.siftUp(position);
    else if (next > previous) this.siftDown(position);
    return true;
  }

  /** Inserts or reprioritizes a record (outside the frame loop: the priority argument may be boxed). */
  push(index: number, priority: number): void {
    this.single[0] = priority;
    this.pushAt(index, this.single, 0);
  }

  /** Changes the priority of a record (outside the frame loop). */
  update(index: number, priority: number): boolean {
    this.single[0] = priority;
    return this.updateAt(index, this.single, 0);
  }

  /** Removes every record; keeps the storage. */
  clear(): void {
    for (let position = 0; position < this.count; position++) this.positions[this.items[position] ?? 0] = ABSENT;
    this.count = 0;
    this.ordered = true;
  }

  /** Writes the record at the end of the heap and returns its position, growing the storage first if needed. */
  private place(index: number, priorities: ArrayLike<number>, at: number): number {
    if (index >= this.positions.length) this.growRecords(index);
    if (this.count === this.items.length) this.growHeap();
    const position = this.count++;
    this.items[position] = index;
    const priority = priorities[at] ?? Infinity;
    // NaN would break every comparison; it sorts last instead (`x === x` is false only for NaN, without a call).
    this.keys[position] = priority === priority ? priority : Infinity;
    this.positions[index] = position;
    return position;
  }

  private removeAtPosition(position: number): void {
    const removed = this.items[position] ?? 0;
    this.positions[removed] = ABSENT;
    const last = --this.count;
    if (position === last) return;
    const moved = this.items[last] ?? 0;
    const movedKey = this.keys[last] ?? 0;
    this.items[position] = moved;
    this.keys[position] = movedKey;
    this.positions[moved] = position;
    // The moved record came from a leaf: it may belong above or below the hole.
    if (position > 0 && this.before(position, (position - 1) >> 1)) this.siftUp(position);
    else this.siftDown(position);
  }

  /** True when the record at position `a` pops before the record at position `b`. */
  private before(a: number, b: number): boolean {
    const keyA = this.keys[a] ?? 0;
    const keyB = this.keys[b] ?? 0;
    if (keyA < keyB) return true;
    if (keyA > keyB) return false;
    return (this.items[a] ?? 0) < (this.items[b] ?? 0);
  }

  private siftUp(start: number): void {
    let position = start;
    while (position > 0) {
      const parent = (position - 1) >> 1;
      if (!this.before(position, parent)) return;
      this.swap(position, parent);
      position = parent;
    }
  }

  private siftDown(start: number): void {
    let position = start;
    for (;;) {
      const left = position * 2 + 1;
      if (left >= this.count) return;
      const right = left + 1;
      const child = right < this.count && this.before(right, left) ? right : left;
      if (!this.before(child, position)) return;
      this.swap(position, child);
      position = child;
    }
  }

  private swap(a: number, b: number): void {
    const itemA = this.items[a] ?? 0;
    const itemB = this.items[b] ?? 0;
    const keyA = this.keys[a] ?? 0;
    this.items[a] = itemB;
    this.items[b] = itemA;
    this.keys[a] = this.keys[b] ?? 0;
    this.keys[b] = keyA;
    this.positions[itemB] = a;
    this.positions[itemA] = b;
  }

  /** Slow path: doubles the heap storage. */
  private growHeap(): void {
    const items = new Int32Array(this.items.length * 2);
    const keys = new Float64Array(this.keys.length * 2);
    items.set(this.items);
    keys.set(this.keys);
    this.items = items;
    this.keys = keys;
  }

  /** Slow path: grows the index-to-position table until it holds `index`. */
  private growRecords(index: number): void {
    let length = this.positions.length * 2;
    while (length <= index) length *= 2;
    const positions = new Int32Array(length).fill(ABSENT);
    positions.set(this.positions);
    this.positions = positions;
  }
}
