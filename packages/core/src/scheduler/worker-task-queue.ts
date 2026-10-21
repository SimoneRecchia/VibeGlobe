/**
 * The worker pool's task queue: a binary min-heap of task records ordered by priority (lower first) and then by
 * submission order, which knows each record's position so a record can be removed or re-prioritized in O(log n).
 */
import type { WorkerTaskDone } from './worker-pool-types.js';

/** One submitted task, from `run` until its outcome is delivered. */
export interface TaskRecord {
  readonly id: number;
  readonly task: string;
  readonly input: unknown;
  readonly transfer: readonly object[];
  readonly timeoutMs: number;
  readonly seq: number;
  readonly enqueuedFrame: number;
  priority: number;
  /** Position in the queue, -1 once dispatched or removed. */
  heapIndex: number;
  /** Cleared when the outcome is delivered, so it is delivered once. */
  done: WorkerTaskDone | undefined;
  cancelled: boolean;
}

function before(a: TaskRecord, b: TaskRecord): boolean {
  return a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq);
}

/** Binary min-heap of task records that knows each record's position, for removal and re-prioritization. */
export class TaskQueue {
  /** The heap array; read it to scan the queued tasks, never write it. */
  readonly items: TaskRecord[] = [];

  /** Adds a record. */
  push(record: TaskRecord): void {
    record.heapIndex = this.items.length;
    this.items.push(record);
    this.up(record.heapIndex);
  }

  /** Removes and returns the record that comes first, if any. */
  pop(): TaskRecord | undefined {
    const top = this.items[0];
    if (top) this.remove(top);
    return top;
  }

  /** Removes a queued record. */
  remove(record: TaskRecord): void {
    const at = record.heapIndex;
    const last = this.items.pop();
    record.heapIndex = -1;
    if (!last || last === record) return;
    this.items[at] = last;
    last.heapIndex = at;
    this.reorder(last);
  }

  /** Restores the order after the priority of a queued record changed. */
  reorder(record: TaskRecord): void {
    this.up(record.heapIndex);
    this.down(record.heapIndex);
  }

  /** Removes and returns every record, in no particular order. */
  drain(): TaskRecord[] {
    const all = this.items.splice(0);
    for (const record of all) record.heapIndex = -1;
    return all;
  }

  private up(start: number): void {
    let at = start;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (!this.swapIfBefore(at, parent)) return;
      at = parent;
    }
  }

  private down(start: number): void {
    let at = start;
    for (;;) {
      const left = 2 * at + 1;
      const right = left + 1;
      let best = at;
      const leftItem = this.items[left];
      const rightItem = this.items[right];
      if (leftItem && before(leftItem, this.items[best] as TaskRecord)) best = left;
      if (rightItem && before(rightItem, this.items[best] as TaskRecord)) best = right;
      if (best === at) return;
      this.swapIfBefore(best, at);
      at = best;
    }
  }

  /** Swaps positions `a` and `b` when the record at `a` must come before the one at `b`. */
  private swapIfBefore(a: number, b: number): boolean {
    const first = this.items[a] as TaskRecord;
    const second = this.items[b] as TaskRecord;
    if (!before(first, second)) return false;
    this.items[a] = second;
    this.items[b] = first;
    second.heapIndex = a;
    first.heapIndex = b;
    return true;
  }
}
