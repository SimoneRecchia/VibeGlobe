/**
 * Memory budget for 3D Tiles content (F462; ADR 0034): least-recently-used eviction of loaded content within a byte
 * budget. Tiles the current view uses are never evicted, so the cache may overflow its budget while the view needs
 * more (CesiumJS's approach; a strict budget would evict visible tiles and open holes). Evicted tiles go back to
 * `unloaded` and load again when revisited.
 */
import type { Tile3D } from './tileset.js';

/** LRU of loaded tiles with a byte budget. */
export class TileContentCache {
  private readonly lru = new Map<Tile3D, number>();
  private total = 0;

  constructor(
    /** Budget in bytes (GPU and RAM together, as the loader counts `tile.bytes`). */
    public budgetBytes: number,
    private readonly release: (tile: Tile3D) => void = () => undefined,
  ) {}

  /** Bytes held by loaded content. */
  get bytes(): number {
    return this.total;
  }

  /** Number of tiles with loaded content. */
  get size(): number {
    return this.lru.size;
  }

  /** Records a tile whose content just loaded (`tile.bytes` set by the loader). */
  add(tile: Tile3D): void {
    this.remove(tile);
    this.lru.set(tile, tile.bytes);
    this.total += tile.bytes;
  }

  /** Marks the tiles a frame used as most recently used. */
  touch(used: Iterable<Tile3D>): void {
    for (const tile of used) {
      const bytes = this.lru.get(tile);
      if (bytes === undefined) continue;
      this.lru.delete(tile);
      this.lru.set(tile, bytes);
    }
  }

  /**
   * Evicts least recently used content until the cache fits its budget, never a tile in `used`.
   * @returns the evicted tiles.
   */
  trim(used: ReadonlySet<Tile3D>): Tile3D[] {
    const evicted: Tile3D[] = [];
    for (const tile of this.lru.keys()) {
      if (this.total <= this.budgetBytes) break;
      if (used.has(tile)) continue;
      this.remove(tile);
      tile.state = 'unloaded';
      tile.bytes = 0;
      this.release(tile);
      evicted.push(tile);
    }
    return evicted;
  }

  private remove(tile: Tile3D): void {
    const bytes = this.lru.get(tile);
    if (bytes === undefined) return;
    this.lru.delete(tile);
    this.total -= bytes;
  }
}
