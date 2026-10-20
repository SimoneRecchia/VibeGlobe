import type { RendererBackend } from '../globe/types.js';
import { buildTileMesh, type TileMeshData } from './surface-mesh.js';
import type { SurfaceTile } from './surface-selection.js';

/** Meshes kept on the GPU after they leave the view, before least-recently-used eviction. */
const CACHE_LIMIT = 1500;
const SWEEP_INTERVAL_FRAMES = 30;

/**
 * Keeps the surface meshes the renderer holds: builds the ones a frame needs, remembers when each was last drawn and
 * evicts the least recently used beyond the limit, never one drawn in the current frame.
 */
export class SurfaceCache {
  private readonly lastUsed = new Map<number, number>();
  private frame = 0;

  constructor(private readonly renderer: RendererBackend) {}

  /** Number of meshes held. */
  get size(): number {
    return this.lastUsed.size;
  }

  /** Makes sure every selected tile has a mesh and writes their keys into `keys`. */
  prepare(tiles: readonly SurfaceTile[], count: number, keys: number[]): void {
    this.frame++;
    for (let i = 0; i < count; i++) {
      const tile = tiles[i];
      if (!tile) continue;
      if (!this.lastUsed.has(tile.key)) this.renderer.addMesh(this.build(tile));
      this.lastUsed.set(tile.key, this.frame);
      keys[i] = tile.key;
    }
    if (this.frame % SWEEP_INTERVAL_FRAMES === 0 && this.lastUsed.size > CACHE_LIMIT) this.evict();
  }

  /** Releases every mesh. */
  clear(): void {
    for (const key of this.lastUsed.keys()) this.renderer.removeMesh(key);
    this.lastUsed.clear();
  }

  private build(tile: SurfaceTile): TileMeshData {
    const size = tile.northRad - tile.southRad;
    // Skirts deeper than the chord sag of the coarser neighbor hide every crack between levels.
    const skirtDepthMeters = Math.max(1, 6378137 * size * size * 0.1);
    return buildTileMesh(tile.key, tile.westRad, tile.southRad, tile.eastRad, tile.northRad, skirtDepthMeters);
  }

  private evict(): void {
    const entries = [...this.lastUsed].filter(([, frame]) => frame < this.frame).sort((a, b) => a[1] - b[1]);
    const excess = this.lastUsed.size - CACHE_LIMIT;
    for (let i = 0; i < excess && i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      this.renderer.removeMesh(entry[0]);
      this.lastUsed.delete(entry[0]);
    }
  }
}
