// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
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

  /**
   * `terrainErrorMeters`: the error of the terrain each surface level shows (ADR 0006 §6), which deepens the skirts;
   * none without terrain.
   */
  constructor(
    private readonly renderer: RendererBackend,
    private readonly terrainErrorMeters?: Float64Array,
  ) {}

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
    // Skirts deeper than the chord sag of the coarser neighbor hide every crack between levels; with terrain, at least
    // twice the terrain error of the tile and its parent, which bounds the height step to a coarser or morphing
    // neighbor (ADR 0006 §6, F137).
    const errors = this.terrainErrorMeters;
    const terrainDepth = errors
      ? 2 * ((errors[tile.level] ?? 0) + (errors[tile.level > 0 ? tile.level - 1 : 0] ?? 0))
      : 0;
    const flatDepth = Math.max(1, 6378137 * size * size * 0.1);
    // They reach out four times the flat depth, which closes the corners between levels (KB-069), and no further: a
    // reach of four times the terrain's depth made nearly flat sheets that stood above every slope falling away from
    // an edge more steeply than 14° (KB-178).
    return buildQuadtreeTileMesh(tile, Math.max(flatDepth, terrainDepth), 4 * flatDepth);
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
