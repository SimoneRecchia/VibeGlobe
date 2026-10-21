import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOW_WATER_RATIO, Residency, type ResidencyOptions } from './residency.hot.js';

function residency(budgetBytes: number, lowWaterRatio?: number): { cache: Residency; evicted: number[] } {
  const evicted: number[] = [];
  const options: ResidencyOptions = { budgetBytes, onEvict: (key) => evicted.push(key), initialCapacity: 2 };
  if (lowWaterRatio !== undefined) options.lowWaterRatio = lowWaterRatio;
  return { cache: new Residency(options), evicted };
}

describe('Residency accounting', () => {
  it('accounts admitted bytes and releases them', () => {
    const { cache, evicted } = residency(1000);
    expect(cache.admit(1, 300)).toBe(true);
    expect(cache.admit(2, 200)).toBe(true);
    expect(cache.usedBytes).toBe(500);
    expect(cache.size).toBe(2);
    expect(cache.bytesOf(1)).toBe(300);
    expect(cache.release(1)).toBe(true);
    expect(cache.release(1)).toBe(false);
    expect(cache.usedBytes).toBe(200);
    expect(cache.has(1)).toBe(false);
    expect(cache.bytesOf(1)).toBeUndefined();
    expect(evicted).toEqual([]);
  });

  it('reconciles a reservation with the size that arrived', () => {
    const { cache } = residency(1000);
    cache.admit(1, 400);
    expect(cache.admit(1, 350)).toBe(true);
    expect(cache.usedBytes).toBe(350);
    expect(cache.admit(1, 900)).toBe(true);
    expect(cache.usedBytes).toBe(900);
    expect(cache.size).toBe(1);
  });

  it('works with keys beyond 32 bits and grows past its initial capacity', () => {
    const { cache } = residency(1_000_000);
    const keys = new Float64Array(100);
    for (let i = 0; i < keys.length; i++) {
      keys[i] = 2 ** 52 + i * 2 ** 33;
      expect(cache.admitAt(keys, i, 10)).toBe(true);
    }
    expect(cache.size).toBe(100);
    for (let i = 0; i < keys.length; i++) expect(cache.touchAt(keys, i, 1)).toBe(true);
    expect(cache.bytesOf(2 ** 52 + 99 * 2 ** 33)).toBe(10);
    expect(cache.usedBytes).toBe(1000);
  });

  it('reports absent keys', () => {
    const { cache } = residency(100);
    expect(cache.touch(5, 1)).toBe(false);
    expect(cache.markDrawn(5, 1)).toBe(false);
    expect(cache.setPinned(5, true)).toBe(false);
    expect(cache.setBusy(5, true)).toBe(false);
    expect(cache.isPinned(5)).toBe(false);
  });

  it('rejects invalid sizes and settings', () => {
    const { cache } = residency(100);
    expect(() => cache.admit(1, -1)).toThrow(RangeError);
    expect(() => cache.admit(1, 1.5)).toThrow(RangeError);
    expect(() => cache.admit(1, Number.NaN)).toThrow(RangeError);
    expect(() => cache.setBudget(Infinity)).toThrow(RangeError);
    expect(() => new Residency({ budgetBytes: 10, lowWaterRatio: 1.5 })).toThrow(RangeError);
    expect(() => new Residency({ budgetBytes: 10, initialCapacity: 0 })).toThrow(RangeError);
  });
});

describe('Residency eviction order (F098)', () => {
  it('evicts the least recently used entries first, just enough to admit', () => {
    const { cache, evicted } = residency(1000);
    for (const key of [1, 2, 3, 4]) cache.admit(key, 250);
    // Frame 1 touches in post-order: children 3 and 1, then their parent 2; 4 is not used.
    cache.touch(3, 1);
    cache.touch(1, 1);
    cache.touch(2, 1);
    expect(cache.admit(5, 400)).toBe(false);
    // Frame 2: nothing used yet, so everything is older than the frame marker.
    cache.trim(2, 0);
    expect(cache.admit(5, 400)).toBe(true);
    expect(evicted).toEqual([4, 3]);
    expect(cache.usedBytes).toBe(900);
  });

  it('refuses instead of overrunning when the entries used this frame fill the budget', () => {
    const { cache, evicted } = residency(1000);
    cache.admit(1, 600);
    cache.admit(2, 300);
    cache.touch(1, 5);
    cache.touch(2, 5);
    expect(cache.admit(3, 200)).toBe(false);
    expect(cache.refusedCount).toBe(1);
    expect(cache.usedBytes).toBe(900);
    expect(evicted).toEqual([]);
    expect(cache.has(3)).toBe(false);
    // A refused reconciliation keeps the reservation as it was.
    expect(cache.admit(2, 500)).toBe(false);
    expect(cache.bytesOf(2)).toBe(300);
  });

  it('evicts nothing when the evictable entries are not enough', () => {
    const { cache, evicted } = residency(1000);
    cache.admit(1, 200);
    cache.admit(2, 700);
    cache.trim(1, 0);
    cache.touch(2, 1);
    // Only key 1 (200 bytes) is evictable: 400 more bytes cannot fit, and key 1 must survive the attempt.
    expect(cache.admit(3, 400)).toBe(false);
    expect(evicted).toEqual([]);
    expect(cache.has(1)).toBe(true);
    // An entry larger than the whole budget is refused at once.
    expect(cache.admit(4, 1001)).toBe(false);
    expect(cache.refusedCount).toBe(2);
  });

  it('never evicts pinned entries; unpinned ones rejoin as recently used (F084)', () => {
    const { cache, evicted } = residency(1000);
    cache.admit(1, 400);
    cache.admit(2, 400);
    expect(cache.setPinned(1, true)).toBe(true);
    expect(cache.isPinned(1)).toBe(true);
    cache.touch(1, 1);
    cache.trim(10, 0);
    // Only key 2 (400 bytes) is evictable; 700 more bytes would need 500 freed.
    expect(cache.admit(3, 700)).toBe(false);
    expect(cache.admit(3, 200)).toBe(true);
    expect(evicted).toEqual([]);
    cache.trim(11, 0);
    // 2 and 3 fill 600 bytes; pinned 1 holds 400. Admitting 500 evicts 2 (older), then 3, never 1.
    expect(cache.admit(4, 500)).toBe(true);
    expect(evicted).toEqual([2, 3]);
    expect(cache.setPinned(1, false)).toBe(true);
    expect(cache.isPinned(1)).toBe(false);
    cache.trim(12, 0);
    cache.touch(4, 12);
    expect(cache.admit(5, 500)).toBe(true);
    expect(evicted).toEqual([2, 3, 1]);
    // Pinning twice or releasing a pinned entry is harmless.
    cache.setPinned(5, true);
    cache.setPinned(5, true);
    expect(cache.release(5)).toBe(true);
    expect(cache.usedBytes).toBe(500);
  });

  it('never evicts entries drawn this frame, and frees them in the next frame (F098)', () => {
    const { cache, evicted } = residency(1000);
    cache.admit(1, 500);
    cache.admit(2, 500);
    cache.trim(3, 0);
    // A fallback ancestor drawn this frame without being touched by the selection.
    expect(cache.markDrawn(1, 3)).toBe(true);
    expect(cache.admit(3, 400)).toBe(true);
    expect(evicted).toEqual([2]);
    cache.trim(4, 0);
    expect(cache.admit(4, 600)).toBe(true);
    expect(evicted).toEqual([2, 1]);
  });

  it('never evicts busy entries', () => {
    const { cache, evicted } = residency(1000);
    cache.admit(1, 500);
    cache.admit(2, 500);
    cache.setBusy(1, true);
    cache.trim(1, 0);
    expect(cache.admit(3, 500)).toBe(true);
    expect(evicted).toEqual([2]);
    cache.trim(2, 0);
    cache.touch(3, 2);
    expect(cache.admit(4, 500)).toBe(false);
    cache.setBusy(1, false);
    expect(cache.admit(4, 500)).toBe(true);
    expect(evicted).toEqual([2, 1]);
  });
});

describe('Residency trimming', () => {
  it('trims to 90% of the budget by default (ADR 0007)', () => {
    expect(DEFAULT_LOW_WATER_RATIO).toBe(0.9);
    const { cache } = residency(1000);
    for (let key = 1; key <= 10; key++) cache.admit(key, 100);
    cache.trim(1, 0);
    cache.admit(11, 100);
    expect(cache.trim(2, 64)).toBe(1);
    expect(cache.usedBytes).toBe(900);
  });

  it('does nothing until an admission needed room', () => {
    const { cache, evicted } = residency(1000);
    for (let key = 1; key <= 9; key++) cache.admit(key, 100);
    expect(cache.trim(5, 64)).toBe(0);
    expect(evicted).toEqual([]);
  });

  it('goes down to the low-water mark within the entry limit per frame', () => {
    const { cache, evicted } = residency(1000, 0.5);
    for (let key = 1; key <= 10; key++) cache.admit(key, 100);
    cache.trim(1, 0);
    expect(cache.admit(11, 100)).toBe(true);
    expect(evicted).toEqual([1]);
    // Trimming started: down to 500 bytes, at most 2 entries per frame, oldest first.
    expect(cache.trim(2, 2)).toBe(2);
    expect(evicted).toEqual([1, 2, 3]);
    expect(cache.trim(3, 2)).toBe(2);
    expect(cache.trim(4, 2)).toBe(1);
    expect(cache.usedBytes).toBe(500);
    expect(evicted).toEqual([1, 2, 3, 4, 5, 6]);
    expect(cache.evictedCount).toBe(6);
    // At the low-water mark, trimming stops until the next admission needs room.
    expect(cache.trim(5, 64)).toBe(0);
  });

  it('stops at the frame marker and resumes in later frames', () => {
    const { cache, evicted } = residency(1000, 0);
    for (let key = 1; key <= 10; key++) cache.admit(key, 100);
    cache.trim(1, 0);
    cache.touch(9, 1);
    cache.touch(10, 1);
    cache.admit(11, 100);
    expect(evicted).toEqual([1]);
    // 2..8 are older than frame 1; 9, 10, 11 were used in it.
    expect(cache.trim(1, 64)).toBe(7);
    expect(cache.usedBytes).toBe(300);
    expect(cache.trim(2, 64)).toBe(3);
    expect(cache.usedBytes).toBe(0);
  });

  it('stops after the time limit', () => {
    let nowMs = 0;
    const evicted: number[] = [];
    const cache = new Residency({
      budgetBytes: 1000,
      lowWaterRatio: 0,
      onEvict: (key) => {
        evicted.push(key);
        nowMs += 0.4;
      },
      nowMs: () => nowMs,
    });
    for (let key = 1; key <= 10; key++) cache.admit(key, 100);
    cache.trim(1, 0);
    cache.admit(11, 100);
    expect(cache.trim(2, 64, 1)).toBe(3);
    expect(cache.trim(3, 64)).toBe(7);
  });

  it('evicts down to a lowered budget', () => {
    const { cache, evicted } = residency(1000, 0.9);
    for (let key = 1; key <= 10; key++) cache.admit(key, 100);
    cache.touch(10, 1);
    cache.setBudget(500);
    expect(cache.budgetBytes).toBe(500);
    // To 90% of the new budget: 450 bytes, so 6 entries go.
    expect(cache.trim(2, 64)).toBe(6);
    expect(evicted).toEqual([1, 2, 3, 4, 5, 6]);
    expect(cache.usedBytes).toBe(400);
  });

  it('tracks the current frame', () => {
    const { cache } = residency(1000);
    cache.admit(1, 1);
    cache.touch(1, 7);
    cache.touch(1, 3);
    expect(cache.currentFrame).toBe(7);
  });
});

type Operation =
  | { kind: 'admit'; key: number; bytes: number }
  | { kind: 'touch' | 'drawn' | 'release' | 'pin' | 'unpin' | 'busy' | 'idle'; key: number }
  | { kind: 'frame' }
  | { kind: 'trim'; maxEntries: number };

const keyArbitrary = fc.oneof(
  fc.integer({ min: 0, max: 24 }),
  fc.integer({ min: 0, max: 8 }).map((k) => 2 ** 50 + k * 2 ** 35),
);
const operationArbitrary: fc.Arbitrary<Operation> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ kind: fc.constant('admit' as const), key: keyArbitrary, bytes: fc.nat(450) }) },
  {
    weight: 6,
    arbitrary: fc.record({
      kind: fc.constantFrom('touch', 'drawn', 'release', 'pin', 'unpin', 'busy', 'idle'),
      key: keyArbitrary,
    }),
  },
  { weight: 2, arbitrary: fc.constant({ kind: 'frame' as const }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('trim' as const), maxEntries: fc.nat(8) }) },
);

interface ModelEntry {
  bytes: number;
  lastUsed: number;
  recency: number;
  pinned: boolean;
  busy: boolean;
  drawn: number;
}

/** A reference model of the residency's rules, written for clarity rather than speed. */
class Model {
  readonly entries = new Map<number, ModelEntry>();
  frame = 0;
  private counter = 0;

  constructor(readonly budget: number) {}

  used(): number {
    let sum = 0;
    for (const entry of this.entries.values()) sum += entry.bytes;
    return sum;
  }

  evictable(key: number): boolean {
    const entry = this.entries.get(key);
    return (
      entry !== undefined && !entry.pinned && !entry.busy && entry.drawn !== this.frame && entry.lastUsed < this.frame
    );
  }

  evictableBytes(except: number): number {
    let sum = 0;
    for (const [key, entry] of this.entries) if (key !== except && this.evictable(key)) sum += entry.bytes;
    return sum;
  }

  /** Evictable keys, least recently used first. */
  lruOrder(): number[] {
    return [...this.entries]
      .filter(([key]) => this.evictable(key))
      .sort((a, b) => a[1].recency - b[1].recency)
      .map(([key]) => key);
  }

  recent(entry: ModelEntry): void {
    entry.lastUsed = this.frame;
    entry.recency = ++this.counter;
  }

  add(key: number, bytes: number): void {
    const entry = { bytes, lastUsed: 0, recency: 0, pinned: false, busy: false, drawn: -1 };
    this.recent(entry);
    this.entries.set(key, entry);
  }
}

/** Applies one operation to both; returns the keys evicted, checked against the model's rules before they apply. */
function apply(cache: Residency, model: Model, evicted: number[], operation: Operation): void {
  const entry = 'key' in operation ? model.entries.get(operation.key) : undefined;
  // An admission never evicts the key it admits.
  const order = model.lruOrder().filter((key) => operation.kind !== 'admit' || key !== operation.key);
  const firstEviction = evicted.length;
  switch (operation.kind) {
    case 'admit': {
      const old = entry?.bytes ?? 0;
      const fits = model.used() - old + operation.bytes <= model.budget;
      const canFit = fits || model.used() - old + operation.bytes - model.evictableBytes(operation.key) <= model.budget;
      expect(cache.admit(operation.key, operation.bytes)).toBe(canFit);
      if (canFit) {
        if (entry) entry.bytes = operation.bytes;
        else model.add(operation.key, operation.bytes);
      }
      break;
    }
    case 'touch':
      expect(cache.touch(operation.key, model.frame)).toBe(entry !== undefined);
      if (entry) model.recent(entry);
      break;
    case 'drawn':
      cache.markDrawn(operation.key, model.frame);
      if (entry) entry.drawn = model.frame;
      break;
    case 'release':
      expect(cache.release(operation.key)).toBe(entry !== undefined);
      model.entries.delete(operation.key);
      break;
    case 'pin':
    case 'unpin':
      cache.setPinned(operation.key, operation.kind === 'pin');
      if (entry && entry.pinned !== (operation.kind === 'pin')) {
        entry.pinned = operation.kind === 'pin';
        if (!entry.pinned) model.recent(entry);
      }
      break;
    case 'busy':
    case 'idle':
      cache.setBusy(operation.key, operation.kind === 'busy');
      if (entry) entry.busy = operation.kind === 'busy';
      break;
    case 'frame':
      model.frame++;
      cache.trim(model.frame, 0);
      break;
    case 'trim':
      expect(cache.trim(model.frame, operation.maxEntries)).toBeLessThanOrEqual(operation.maxEntries);
      break;
  }
  // Evictions are a prefix of the evictable entries in LRU order: protected and recently used ones never go.
  const victims = evicted.slice(firstEviction);
  expect(victims).toEqual(order.slice(0, victims.length));
  for (const key of victims) model.entries.delete(key);
}

describe('Residency properties (F098)', () => {
  test.prop([fc.array(operationArbitrary, { maxLength: 300 })])(
    'never exceeds the budget, never evicts protected entries and evicts in LRU order',
    (operations) => {
      const { cache, evicted } = residency(1000);
      const model = new Model(1000);
      for (const operation of operations) {
        apply(cache, model, evicted, operation);
        expect(cache.usedBytes).toBeLessThanOrEqual(1000);
        expect(cache.usedBytes).toBe(model.used());
        expect(cache.size).toBe(model.entries.size);
        for (const [key, entry] of model.entries) {
          expect(cache.bytesOf(key)).toBe(entry.bytes);
          expect(cache.isPinned(key)).toBe(entry.pinned);
        }
      }
    },
  );
});
