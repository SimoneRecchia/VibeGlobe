/**
 * The RAM tier of ADR 0007 §Memory (F097): encoded tile bytes kept after decode, so a tile that left the view, or
 * whose GPU copy was evicted or lost with the device, is decoded again without a new request. Lookups happen once per
 * dispatched or decoded tile, not per frame, so a `Map` serves; it keeps insertion order, which is the LRU order when a
 * hit re-inserts its entry.
 */

/** The coalescing key of a tile: source id, tile key and variant, as a string or a packed number (ADR 0007). */
export type RamTierKey = string | number;

/** A tile's bytes as they arrived from the network, with the content type the decoder needs. */
export interface EncodedTile {
  readonly bytes: ArrayBuffer;
  readonly contentType: string;
}

/** Bytes accounted per entry on top of the payload: the map entry, the record and the buffer's own header. */
export const DEFAULT_RAM_ENTRY_OVERHEAD_BYTES = 128;

/** A stored tile with the bytes it accounts, fixed when stored (a buffer detached later would read 0). */
interface Entry {
  readonly tile: EncodedTile;
  readonly accounted: number;
}

/** Settings of a {@link RamTier}. */
export interface RamTierOptions {
  /** The hard cap, in bytes, overhead included; usage never exceeds it. */
  budgetBytes: number;
  /** Bytes accounted per entry on top of its payload (default 128). */
  overheadBytesPerEntry?: number;
  /**
   * False for keys that must stay (their tile is pinned, drawn or has pipeline work in progress, ADR 0007 §Protected
   * tiles); every entry is evictable when omitted.
   */
  canEvict?: (key: RamTierKey) => boolean;
  /**
   * Called with the key of every evicted entry, after it is gone; evicting the RAM copy evicts the GPU copy too
   * (ADR 0007 §Tiers). It must not change this tier while it runs.
   */
  onEvict?: (key: RamTierKey) => void;
}

function checkBytes(name: string, bytes: number): void {
  if (!(bytes >= 0) || bytes % 1 !== 0) throw new RangeError(`${name} must be a non-negative integer, got ${bytes}`);
}

/**
 * A byte-budgeted LRU of encoded tiles. {@link put} evicts the least recently used evictable entries just enough to
 * make room and refuses, evicting nothing, when that cannot be done, so usage never exceeds the budget. The tier keeps
 * the buffers it is given: callers transfer a copy to the decoding worker, never the stored buffer.
 */
export class RamTier {
  private readonly entries = new Map<RamTierKey, Entry>();
  private readonly overhead: number;
  private readonly canEvict: ((key: RamTierKey) => boolean) | undefined;
  private readonly onEvict: ((key: RamTierKey) => void) | undefined;
  private budget = 0;
  private used = 0;
  private hitCount = 0;
  private missCount = 0;
  private refusedCount = 0;
  private evictedCount = 0;

  constructor(options: RamTierOptions) {
    this.overhead = options.overheadBytesPerEntry ?? DEFAULT_RAM_ENTRY_OVERHEAD_BYTES;
    checkBytes('overheadBytesPerEntry', this.overhead);
    this.canEvict = options.canEvict;
    this.onEvict = options.onEvict;
    this.setBudget(options.budgetBytes);
  }

  /** Bytes accounted, overhead included. */
  get usedBytes(): number {
    return this.used;
  }

  /** The hard cap, in bytes. */
  get budgetBytes(): number {
    return this.budget;
  }

  /** Number of entries. */
  get size(): number {
    return this.entries.size;
  }

  /** Lookups that found their key. */
  get hits(): number {
    return this.hitCount;
  }

  /** Lookups that did not. */
  get misses(): number {
    return this.missCount;
  }

  /** Puts refused because the evictable entries could not make room. */
  get refused(): number {
    return this.refusedCount;
  }

  /** Entries evicted so far. */
  get evictions(): number {
    return this.evictedCount;
  }

  /** Bytes an entry with a payload of `byteLength` bytes accounts. */
  accountedBytes(byteLength: number): number {
    return byteLength + this.overhead;
  }

  /** The tile stored under a key, which becomes the most recently used; counts a hit or a miss. */
  get(key: RamTierKey): EncodedTile | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      this.missCount++;
      return undefined;
    }
    this.hitCount++;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.tile;
  }

  /** The tile stored under a key, without changing the LRU order or the counters. */
  peek(key: RamTierKey): EncodedTile | undefined {
    return this.entries.get(key)?.tile;
  }

  /** True when a key is stored. */
  has(key: RamTierKey): boolean {
    return this.entries.has(key);
  }

  /**
   * Stores a tile under a key as the most recently used entry, replacing any previous one. Returns false, changing
   * nothing, when evicting every evictable entry would not make room; the refusal is counted.
   */
  put(key: RamTierKey, tile: EncodedTile): boolean {
    const previous = this.entries.get(key);
    const delta = this.accountedBytes(tile.bytes.byteLength) - (previous?.accounted ?? 0);
    if (this.used + delta > this.budget && !this.makeRoom(this.used + delta - this.budget, key)) {
      this.refusedCount++;
      return false;
    }
    this.entries.delete(key);
    this.entries.set(key, { tile, accounted: this.accountedBytes(tile.bytes.byteLength) });
    this.used += delta;
    return true;
  }

  /** Removes a key without calling `onEvict` (the caller dropped it); false when absent. */
  delete(key: RamTierKey): boolean {
    const entry = this.entries.get(key);
    if (entry === undefined) return false;
    this.entries.delete(key);
    this.used -= entry.accounted;
    return true;
  }

  /**
   * Changes the budget; a lower one evicts least recently used evictable entries until usage fits, as far as the
   * protected entries allow. Returns the number of entries evicted.
   */
  setBudget(bytes: number): number {
    checkBytes('budgetBytes', bytes);
    this.budget = bytes;
    const before = this.evictedCount;
    if (this.used > bytes) this.evictUpTo(this.used - bytes, undefined);
    return this.evictedCount - before;
  }

  /** Removes every entry without calling `onEvict`. */
  clear(): void {
    this.entries.clear();
    this.used = 0;
  }

  private evictable(key: RamTierKey, exclude: RamTierKey | undefined): boolean {
    return key !== exclude && (this.canEvict === undefined || this.canEvict(key));
  }

  /** Evicts `neededBytes` of evictable entries other than `exclude`, or nothing (false) if there are not enough. */
  private makeRoom(neededBytes: number, exclude: RamTierKey): boolean {
    let available = 0;
    for (const [key, entry] of this.entries) {
      if (available >= neededBytes) break;
      if (this.evictable(key, exclude)) available += entry.accounted;
    }
    if (available < neededBytes) return false;
    this.evictUpTo(neededBytes, exclude);
    return true;
  }

  /** Evicts least recently used evictable entries other than `exclude` until `neededBytes` are freed or none is left. */
  private evictUpTo(neededBytes: number, exclude: RamTierKey | undefined): void {
    let freed = 0;
    for (const [key, entry] of this.entries) {
      if (freed >= neededBytes) break;
      if (!this.evictable(key, exclude)) continue;
      const bytes = entry.accounted;
      this.entries.delete(key);
      this.used -= bytes;
      freed += bytes;
      this.evictedCount++;
      this.onEvict?.(key);
    }
  }
}
