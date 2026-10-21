import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RAM_ENTRY_OVERHEAD_BYTES,
  type EncodedTile,
  RamTier,
  type RamTierKey,
  type RamTierOptions,
} from './ram-tier.js';

function encoded(byteLength: number): EncodedTile {
  return { bytes: new ArrayBuffer(byteLength), contentType: 'image/png' };
}

/** A tier with no per-entry overhead, so the arithmetic below is in payload bytes. */
function tier(budgetBytes: number, canEvict?: (key: RamTierKey) => boolean): { ram: RamTier; evicted: RamTierKey[] } {
  const evicted: RamTierKey[] = [];
  const options: RamTierOptions = { budgetBytes, overheadBytesPerEntry: 0, onEvict: (key) => evicted.push(key) };
  if (canEvict) options.canEvict = canEvict;
  return { ram: new RamTier(options), evicted };
}

describe('RamTier (F097)', () => {
  it('returns stored tiles and counts hits and misses', () => {
    const { ram } = tier(1000);
    const tile = encoded(100);
    expect(ram.put('osm/12/3', tile)).toBe(true);
    expect(ram.get('osm/12/3')).toBe(tile);
    expect(ram.get('osm/12/4')).toBeUndefined();
    expect(ram.hits).toBe(1);
    expect(ram.misses).toBe(1);
    expect(ram.has('osm/12/3')).toBe(true);
    expect(ram.peek('osm/12/3')).toBe(tile);
    expect(ram.peek('nothing')).toBeUndefined();
    expect(ram.hits).toBe(1);
  });

  it('keeps string and number keys apart', () => {
    const { ram } = tier(1000);
    ram.put(42, encoded(10));
    ram.put('42', encoded(20));
    expect(ram.size).toBe(2);
    expect(ram.peek(42)?.bytes.byteLength).toBe(10);
    expect(ram.peek(2 ** 52)).toBeUndefined();
  });

  it('accounts payload plus a fixed overhead per entry', () => {
    const ram = new RamTier({ budgetBytes: 10_000 });
    ram.put(1, encoded(1000));
    expect(DEFAULT_RAM_ENTRY_OVERHEAD_BYTES).toBe(128);
    expect(ram.accountedBytes(1000)).toBe(1128);
    expect(ram.usedBytes).toBe(1128);
    // The size is fixed when stored, so a buffer transferred away later does not corrupt the accounting.
    ram.put(1, encoded(500));
    expect(ram.usedBytes).toBe(628);
    expect(ram.delete(1)).toBe(true);
    expect(ram.delete(1)).toBe(false);
    expect(ram.usedBytes).toBe(0);
  });

  it('evicts least recently used tiles first, hits counting as use', () => {
    const { ram, evicted } = tier(1000);
    for (const key of ['a', 'b', 'c', 'd']) ram.put(key, encoded(250));
    ram.get('a');
    expect(ram.put('e', encoded(300))).toBe(true);
    expect(evicted).toEqual(['b', 'c']);
    expect(ram.usedBytes).toBe(1000 - 500 + 300);
    expect(ram.evictions).toBe(2);
    // Replacing a key keeps one entry and makes it the most recent.
    ram.put('d', encoded(250));
    // Order now a, e, d: 500 more bytes need a (250) and e (300).
    expect(ram.put('f', encoded(500))).toBe(true);
    expect(evicted).toEqual(['b', 'c', 'a', 'e']);
    expect(ram.usedBytes).toBe(750);
  });

  it('refuses rather than exceed the budget when protected tiles fill it', () => {
    const protectedKeys = new Set<RamTierKey>(['a', 'b']);
    const { ram, evicted } = tier(1000, (key) => !protectedKeys.has(key));
    ram.put('a', encoded(400));
    ram.put('b', encoded(400));
    ram.put('c', encoded(100));
    expect(ram.put('d', encoded(300))).toBe(false);
    expect(evicted).toEqual([]);
    expect(ram.refused).toBe(1);
    expect(ram.has('c')).toBe(true);
    expect(ram.put('d', encoded(200))).toBe(true);
    expect(evicted).toEqual(['c']);
    expect(ram.put('huge', encoded(5000))).toBe(false);
    // A refused replacement keeps the previous tile.
    const before = ram.peek('d');
    expect(ram.put('d', encoded(900))).toBe(false);
    expect(ram.peek('d')).toBe(before);
  });

  it('evicts down to a lowered budget as far as protection allows', () => {
    const { ram, evicted } = tier(1000, (key) => key !== 'a');
    for (const key of ['a', 'b', 'c', 'd']) ram.put(key, encoded(250));
    expect(ram.setBudget(600)).toBe(2);
    expect(evicted).toEqual(['b', 'c']);
    expect(ram.usedBytes).toBe(500);
    expect(ram.setBudget(100)).toBe(1);
    expect(ram.usedBytes).toBe(250);
    expect(ram.budgetBytes).toBe(100);
    expect(ram.put('e', encoded(10))).toBe(false);
  });

  it('clears and rejects invalid settings', () => {
    const { ram, evicted } = tier(1000);
    ram.put(1, encoded(10));
    ram.clear();
    expect(ram.size).toBe(0);
    expect(ram.usedBytes).toBe(0);
    expect(evicted).toEqual([]);
    expect(() => new RamTier({ budgetBytes: -1 })).toThrow(RangeError);
    expect(() => new RamTier({ budgetBytes: 10, overheadBytesPerEntry: 0.5 })).toThrow(RangeError);
  });

  test.prop([
    fc.array(
      fc.record({
        kind: fc.constantFrom('put', 'get', 'delete', 'protect', 'unprotect'),
        key: fc.integer({ min: 0, max: 15 }),
        bytes: fc.nat(400),
      }),
      { maxLength: 300 },
    ),
  ])('never exceeds the budget, never evicts protected tiles and accounts every byte (F098)', (operations) => {
    const protectedKeys = new Set<RamTierKey>();
    const evicted: RamTierKey[] = [];
    const ram = new RamTier({
      budgetBytes: 1000,
      overheadBytesPerEntry: 16,
      canEvict: (key) => !protectedKeys.has(key),
      onEvict: (key) => evicted.push(key),
    });
    const sizes = new Map<RamTierKey, number>();
    for (const { kind, key, bytes } of operations) {
      const evictedBefore = evicted.length;
      if (kind === 'put' && ram.put(key, encoded(bytes))) sizes.set(key, bytes + 16);
      else if (kind === 'get') expect(ram.get(key) !== undefined).toBe(sizes.has(key));
      else if (kind === 'delete') expect(ram.delete(key)).toBe(sizes.delete(key));
      else if (kind === 'protect') protectedKeys.add(key);
      else if (kind === 'unprotect') protectedKeys.delete(key);
      for (const victim of evicted.slice(evictedBefore)) {
        expect(protectedKeys.has(victim)).toBe(false);
        expect(victim).not.toBe(key);
        sizes.delete(victim);
      }
      expect(ram.usedBytes).toBeLessThanOrEqual(1000);
      expect(ram.usedBytes).toBe([...sizes.values()].reduce((sum, size) => sum + size, 0));
      expect(ram.size).toBe(sizes.size);
    }
  });
});
