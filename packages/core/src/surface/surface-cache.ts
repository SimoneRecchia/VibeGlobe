import { IntegerKeyMap } from '../collections/integer-key-map.hot.js';
import type { RendererBackend } from '../globe/types.js';
import { buildQuadtreeTileMesh, type TileMeshData } from './surface-mesh.js';
import type { QuadtreeTile } from './surface-quadtree.hot.js';

/** Meshes kept on the GPU after they leave the view, before least-recently-used eviction. */
const CACHE_LIMIT = 1500;
const SWEEP_INTERVAL_FRAMES = 30;

/**
 * Keeps the surface meshes the renderer holds: builds the ones a frame needs, remembers when each was last drawn and
 * evicts the least recently used beyond the limit, never one drawn in the current frame.
 */
export class SurfaceCache {
  /** Frame each held mesh was last drawn in, by tile key (no Map: it boxes keys beyond 31 bits, ADR 0018). */
  private readonly lastUsed = new IntegerKeyMap<number>(CACHE_LIMIT);
  private frame = 0;

  constructor(private readonly renderer: RendererBackend) {}

  /** Number of meshes held. */
  get size(): number {
    return this.lastUsed.size;
  }

  /** Makes sure every selected tile has a mesh and writes their keys into `keys`. */
  prepare(tiles: readonly QuadtreeTile[], count: number, keys: Float64Array): void {
    this.frame++;
    for (let i = 0; i < count; i++) {
      const tile = tiles[i];
      if (!tile) continue;
      keys[i] = tile.key;
      if (!this.lastUsed.hasAt(keys, i)) this.renderer.addMesh(this.build(tile));
      this.lastUsed.setAt(keys, i, this.frame);
    }
    if (this.frame % SWEEP_INTERVAL_FRAMES === 0 && this.lastUsed.size > CACHE_LIMIT) this.evict();
  }

  /** Releases every mesh. */
  clear(): void {
    this.lastUsed.forEach((_, key) => this.renderer.removeMesh(key));
    this.lastUsed.clear();
  }

  private build(tile: QuadtreeTile): TileMeshData {
    const size = tile.northRad - tile.southRad;
    // Skirts deeper than the chord sag of the coarser neighbor hide every crack between levels.
    const skirtDepthMeters = Math.max(1, 6378137 * size * size * 0.1);
    return buildQuadtreeTileMesh(tile, skirtDepthMeters);
  }

  private evict(): void {
    const entries: [number, number][] = [];
    this.lastUsed.forEach((frame, key) => {
      if (frame < this.frame) entries.push([key, frame]);
    });
    entries.sort((a, b) => a[1] - b[1]);
    const excess = this.lastUsed.size - CACHE_LIMIT;
    for (let i = 0; i < excess && i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      this.renderer.removeMesh(entry[0]);
      this.lastUsed.delete(entry[0]);
    }
  }
}
