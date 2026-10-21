import type { Camera } from '../camera/camera.js';
import type { DrawList } from '../imagery/draw-list.js';
import {
  quadtreeTileErrorsPx,
  type QuadtreeSelectionOptions,
  type QuadtreeTile,
} from '../surface/surface-quadtree.hot.js';
import type { RendererStats, SurfaceStats, SurfaceTileInfo } from './types.js';

const DEG = 180 / Math.PI;
const ROOTS = ['mercator', 'north-cap', 'south-cap'] as const;

/**
 * The selected tiles of a frame in degrees, with their refinement errors for the current camera and the imagery level
 * each shows (diagnostics; allocates, never called by the frame loop).
 */
export function describeSurfaceTiles(
  tiles: readonly QuadtreeTile[],
  draws: DrawList,
  camera: Camera,
  selection: QuadtreeSelectionOptions,
): SurfaceTileInfo[] {
  const errors = new Float64Array(2);
  return tiles.slice(0, draws.count).map((tile, index) => {
    quadtreeTileErrorsPx(camera, tile, selection, errors);
    const imageryLevel = draws.imageryLevels[index] ?? -1;
    return {
      root: ROOTS[tile.root],
      level: tile.level,
      x: tile.x,
      y: tile.y,
      westDeg: tile.westRad * DEG,
      southDeg: tile.southRad * DEG,
      eastDeg: tile.eastRad * DEG,
      northDeg: tile.northRad * DEG,
      geometricErrorPx: errors[0] ?? 0,
      texelErrorPx: errors[1] ?? 0,
      imageryLevel: imageryLevel >= 0 ? imageryLevel : null,
    };
  });
}

/** A frame's selection counters. */
export function surfaceStats(
  tiles: readonly QuadtreeTile[],
  draws: DrawList,
  selection: QuadtreeSelectionOptions,
): SurfaceStats {
  let maxLevel = 0;
  let fromAncestor = 0;
  let onBaseImage = 0;
  for (let i = 0; i < draws.count; i++) {
    const level = tiles[i]?.level ?? 0;
    const imageryLevel = draws.imageryLevels[i] ?? -1;
    maxLevel = Math.max(maxLevel, level);
    if (imageryLevel < 0) onBaseImage++;
    else if (imageryLevel < level) fromAncestor++;
  }
  return {
    tiles: draws.count,
    maxLevel,
    culledByFrustum: selection.culledByFrustum ?? 0,
    culledByHorizon: selection.culledByHorizon ?? 0,
    fromAncestor,
    onBaseImage,
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
