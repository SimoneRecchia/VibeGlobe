import { DrawList, drawOnBaseImage } from '../imagery/draw-list.js';
import type { SurfaceCache } from '../surface/surface-cache.js';
import { selectQuadtreeTiles, type QuadtreeTile } from '../surface/surface-quadtree.hot.js';
import type { Camera } from '../camera/camera.js';
import { describeSurfaceTiles, surfaceStats } from './diagnostics.js';
import type { SurfaceStats, SurfaceTileInfo, TileDrawList } from './types.js';

/** Surface tile keys are exact integers up to level 25 (quadtreeTileKey). */
const MAX_LEVEL = 25;

/**
 * The surface part of a frame: selects the quadtree tiles for the camera, makes sure their meshes exist and fills the
 * draw list the renderer draws, reusing every array (ADR 0018). Keeps what the last drawn frame selected for the
 * diagnostics API.
 */
export class SurfaceFrame {
  private readonly tiles: QuadtreeTile[] = [];
  private readonly draws = new DrawList();
  /** Tiles the last drawn frame selected. */
  private drawnCount = 0;
  private readonly selection = { maxScreenErrorPx: 1, maxLevel: MAX_LEVEL, minLevel: 2 };

  constructor(maxScreenErrorPx: number, minLevel: number) {
    this.selection.maxScreenErrorPx = maxScreenErrorPx;
    this.selection.minLevel = minLevel;
  }

  /** Selects this frame's tiles and returns their draws. */
  prepare(camera: Camera, cache: SurfaceCache): TileDrawList {
    const count = selectQuadtreeTiles(camera, this.selection, this.tiles);
    this.draws.reserve(count);
    cache.prepare(this.tiles, count, this.draws.meshKeys);
    drawOnBaseImage(this.draws, this.tiles, count);
    return this.draws;
  }

  /** Records that the prepared frame was drawn; returns its tile count. */
  drawn(): number {
    this.drawnCount = this.draws.count;
    return this.drawnCount;
  }

  /** The tiles of the last drawn frame (`Globe.surfaceTiles`). */
  describe(): SurfaceTileInfo[] {
    return describeSurfaceTiles(this.tiles, this.drawnCount);
  }

  /** Selection counters of the last drawn frame (`Globe.surfaceStats`). */
  stats(): SurfaceStats {
    return surfaceStats(this.tiles, this.drawnCount, this.selection);
  }
}
