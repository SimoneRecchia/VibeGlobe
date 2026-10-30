import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { PriorityHeap } from './priority-heap.hot.js';

/** Priorities shaped like ADR 0007's keys (`class × 1024 + level + 2·d`), with frequent ties. */
const priorityArbitrary = fc.oneof(
  fc
    .integer({ min: 0, max: 4 })
    .chain((klass) =>
      fc
        .tuple(fc.integer({ min: 0, max: 22 }), fc.double({ min: 0, max: 1, noNaN: true }))
        .map(([level, d]) => klass * 1024 + level + 2 * d),
    ),
  fc.integer({ min: 0, max: 5 }),
);
const indexArbitrary = fc.integer({ min: 0, max: 60 });
const operationArbitrary = fc.oneof(
  fc.record({ kind: fc.constant('push' as const), index: indexArbitrary, priority: priorityArbitrary }),
  fc.record({ kind: fc.constant('update' as const), index: indexArbitrary, priority: priorityArbitrary }),
  fc.record({ kind: fc.constant('remove' as const), index: indexArbitrary }),
  fc.record({ kind: fc.constant('pop' as const) }),
  fc.record({ kind: fc.constant('peek' as const) }),
);

/** The record a reference map would pop: lowest priority, then lowest index; -1 when empty. */
function referenceBest(reference: Map<number, number>): number {
  let best = -1;
  let bestPriority = Infinity;
  for (const [index, priority] of reference) {
    if (best < 0 || priority < bestPriority || (priority === bestPriority && index < best)) {
      best = index;
      bestPriority = priority;
    }
  }
  return best;
}

/** Pushes or reprioritizes a record with a single priority. */
const push = (heap: PriorityHeap, index: number, priority: number): void => heap.pushAt(index, [priority], 0);
/** Reprioritizes a record with a single priority. */
const update = (heap: PriorityHeap, index: number, priority: number): boolean => heap.updateAt(index, [priority], 0);

/** Drains the heap into an array of record indices. */
function drain(heap: PriorityHeap): number[] {
  const order: number[] = [];
  for (let index = heap.pop(); index >= 0; index = heap.pop()) order.push(index);
  return order;
}

describe('PriorityHeap', () => {
  test.prop([fc.array(operationArbitrary, { maxLength: 300 })])(
    'pops like a reference ordered by priority, then index',
    (operations) => {
      const heap = new PriorityHeap(1, 1);
      const reference = new Map<number, number>();
      for (const operation of operations) {
        switch (operation.kind) {
          case 'push':
            push(heap, operation.index, operation.priority);
            reference.set(operation.index, operation.priority);
            break;
          case 'update':
            expect(update(heap, operation.index, operation.priority)).toBe(reference.has(operation.index));
            if (reference.has(operation.index)) reference.set(operation.index, operation.priority);
            break;
          case 'remove':
            expect(heap.remove(operation.index)).toBe(reference.delete(operation.index));
            break;
          case 'pop': {
            const expected = referenceBest(reference);
            expect(heap.pop()).toBe(expected);
            reference.delete(expected);
            break;
          }
          case 'peek':
            expect(heap.peek()).toBe(referenceBest(reference));
            break;
        }
        expect(heap.size).toBe(reference.size);
        for (const index of reference.keys()) expect(heap.has(index)).toBe(true);
      }
      const expected = [...reference].sort((a, b) => a[1] - b[1] || a[0] - b[0]).map(([index]) => index);
      expect(drain(heap)).toEqual(expected);
    },
  );

  it('orders ADR 0007 classes before levels before distance from the focus', () => {
    const heap = new PriorityHeap();
    // Record 0: prefetch level 2; 1: visible level 10 at the corner; 2: visible level 10 at the center;
    // 3: pinned base level 1; 4: visible level 3 at the corner.
    const priorities = Float64Array.of(4 * 1024 + 2, 1024 + 10 + 2, 1024 + 10, 1, 1024 + 3 + 2);
    for (let index = 0; index < priorities.length; index++) heap.pushAt(index, priorities, index);
    expect(drain(heap)).toEqual([3, 4, 2, 1, 0]);
  });

  it('reads priorities from the caller array and updates in both directions', () => {
    const heap = new PriorityHeap();
    const priorities = Float64Array.of(5, 3, 8);
    heap.pushAt(0, priorities, 0);
    heap.pushAt(1, priorities, 1);
    heap.pushAt(2, priorities, 2);
    expect(heap.peek()).toBe(1);
    priorities[2] = 1;
    expect(heap.updateAt(2, priorities, 2)).toBe(true);
    expect(heap.peek()).toBe(2);
    priorities[2] = 9;
    heap.updateAt(2, priorities, 2);
    expect(heap.peek()).toBe(1);
    // Pushing a present record reprioritizes it instead of adding it twice.
    priorities[0] = 0;
    heap.pushAt(0, priorities, 0);
    expect(heap.size).toBe(3);
    expect(drain(heap)).toEqual([0, 1, 2]);
  });

  it('reports absent records and an empty heap with -1 and false', () => {
    const heap = new PriorityHeap();
    expect(heap.pop()).toBe(-1);
    expect(heap.peek()).toBe(-1);
    expect(heap.remove(3)).toBe(false);
    expect(update(heap, 3, 1)).toBe(false);
    expect(heap.has(-1)).toBe(false);
    expect(heap.has(1_000_000)).toBe(false);
    expect(heap.size).toBe(0);
  });

  it('sorts NaN priorities last and keeps the order valid', () => {
    const heap = new PriorityHeap();
    push(heap, 0, Number.NaN);
    push(heap, 1, 7);
    push(heap, 2, Infinity);
    push(heap, 3, Number.NaN);
    push(heap, 4, -1);
    update(heap, 4, Number.NaN);
    expect(drain(heap)).toEqual([1, 0, 2, 3, 4]);
  });

  it('grows past its initial capacities and record indices', () => {
    const heap = new PriorityHeap(1, 1);
    const count = 2000;
    for (let i = 0; i < count; i++) push(heap, count * 3 - i * 3, i % 17);
    expect(heap.size).toBe(count);
    let previous = -Infinity;
    let popped = 0;
    for (let index = heap.pop(); index >= 0; index = heap.pop()) {
      const priority = (count - index / 3) % 17;
      expect(priority).toBeGreaterThanOrEqual(previous);
      previous = priority;
      popped++;
    }
    expect(popped).toBe(count);
  });

  it('removes from the middle', () => {
    const heap = new PriorityHeap();
    for (let i = 0; i < 10; i++) push(heap, i, i);
    expect(heap.remove(5)).toBe(true);
    expect(heap.remove(0)).toBe(true);
    expect(heap.remove(9)).toBe(true);
    expect(drain(heap)).toEqual([1, 2, 3, 4, 6, 7, 8]);
  });
});
