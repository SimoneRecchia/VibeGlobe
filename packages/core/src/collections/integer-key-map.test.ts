import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { IntegerKeyMap } from './integer-key-map.hot.js';

/** Keys from a small pool, so operations collide, plus keys beyond 32 bits like deep surface tiles. */
const keyArbitrary = fc.oneof(
  fc.integer({ min: 0, max: 40 }),
  fc.integer({ min: 0, max: 40 }).map((k) => 2 ** 52 + k * 2 ** 33),
  fc.constantFrom(0, 2 ** 31, 2 ** 32, 2 ** 32 + 1, Number.MAX_SAFE_INTEGER),
);
const operationArbitrary = fc.oneof(
  fc.record({ kind: fc.constant('set' as const), key: keyArbitrary, value: fc.integer() }),
  fc.record({ kind: fc.constant('delete' as const), key: keyArbitrary }),
  fc.record({ kind: fc.constant('get' as const), key: keyArbitrary }),
);

describe('IntegerKeyMap', () => {
  test.prop([fc.array(operationArbitrary, { maxLength: 400 })])('behaves like a Map', (operations) => {
    const map = new IntegerKeyMap<number>(1);
    const reference = new Map<number, number>();
    for (const operation of operations) {
      if (operation.kind === 'set') {
        map.set(operation.key, operation.value);
        reference.set(operation.key, operation.value);
      } else if (operation.kind === 'delete') {
        expect(map.delete(operation.key)).toBe(reference.get(operation.key));
        reference.delete(operation.key);
      } else {
        expect(map.get(operation.key)).toBe(reference.get(operation.key));
        expect(map.has(operation.key)).toBe(reference.has(operation.key));
      }
      expect(map.size).toBe(reference.size);
    }
    const entries: [number, number][] = [];
    map.forEach((value, key) => entries.push([key, value]));
    expect(entries.sort((a, b) => a[0] - b[0])).toEqual([...reference].sort((a, b) => a[0] - b[0]));
  });

  it('reads keys from the caller array and clears', () => {
    const keys = [3, 2 ** 40, 7];
    const map = new IntegerKeyMap<string>();
    keys.forEach((_, at) => map.setAt(keys, at, `v${at}`));
    expect(map.getAt(keys, 1)).toBe('v1');
    expect(map.hasAt([2 ** 40 + 1], 0)).toBe(false);
    expect(map.deleteAt(keys, 0)).toBe('v0');
    expect(map.deleteAt(keys, 0)).toBeUndefined();
    map.clear();
    expect(map.size).toBe(0);
    expect(map.get(7)).toBeUndefined();
  });
});
