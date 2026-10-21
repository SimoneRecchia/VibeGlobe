import type { QuadtreeSelectionOptions, QuadtreeTile } from '../surface/surface-quadtree.hot.js';
import type { RendererStats, SurfaceStats, SurfaceTileInfo } from './types.js';

const DEG = 180 / Math.PI;
const ROOTS = ['mercator', 'north-cap', 'south-cap'] as const;

/** The selected tiles of a frame in degrees (diagnostics; allocates, never called by the frame loop). */
export function describeSurfaceTiles(tiles: readonly QuadtreeTile[], count: number): SurfaceTileInfo[] {
  return tiles.slice(0, count).map((tile) => ({
    root: ROOTS[tile.root],
    level: tile.level,
    x: tile.x,
    y: tile.y,
    westDeg: tile.westRad * DEG,
    southDeg: tile.southRad * DEG,
    eastDeg: tile.eastRad * DEG,
    northDeg: tile.northRad * DEG,
  }));
}

/** A frame's selection counters. */
export function surfaceStats(
  tiles: readonly QuadtreeTile[],
  count: number,
  selection: QuadtreeSelectionOptions,
): SurfaceStats {
  let maxLevel = 0;
  for (let i = 0; i < count; i++) maxLevel = Math.max(maxLevel, tiles[i]?.level ?? 0);
  return {
    tiles: count,
    maxLevel,
    culledByFrustum: selection.culledByFrustum ?? 0,
    culledByHorizon: selection.culledByHorizon ?? 0,
  };
}

/** Renderer counters before a renderer exists. */
export const NO_RENDERER_STATS: RendererStats = Object.freeze({
  drawCalls: 0,
  triangles: 0,
  textureUploads: 0,
  matrixUpdates: 0,
  pipelineCompiles: 0,
  gpuFrameMs: null,
});
