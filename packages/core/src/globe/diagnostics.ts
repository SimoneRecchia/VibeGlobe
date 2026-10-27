// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { Camera } from '../camera/camera.js';
import type { DrawList } from '../imagery/draw-list.js';
import {
  quadtreeTileErrorsPx,
  type QuadtreeSelectionOptions,
  type QuadtreeTile,
} from '../surface/surface-quadtree.hot.js';
import type { ImageryLoaderStats } from '../imagery/imagery-loader.hot.js';
import type { RendererStats, ResourceCounts, SurfaceStats, SurfaceTileInfo, TerrainStats } from './types.js';

const DEG = 180 / Math.PI;
const ROOTS = ['mercator', 'north-cap', 'south-cap'] as const;

/**
 * The selected tiles of a frame in degrees, with their refinement errors for the current camera and the imagery and
 * terrain levels each shows (diagnostics; allocates, never called by the frame loop).
 */
export function describeSurfaceTiles(
  tiles: readonly QuadtreeTile[],
  draws: DrawList,
  camera: Camera,
  selection: QuadtreeSelectionOptions,
): SurfaceTileInfo[] {
  const errors = new Float64Array(3);
  return tiles.slice(0, draws.count).map((tile, index) => {
    quadtreeTileErrorsPx(camera, tile, selection, errors);
    const imageryLevel = draws.imageryLevels[index] ?? -1;
    const terrainLevel = selection.terrainErrorMeters ? (draws.terrain.levels[index] ?? -1) : -1;
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
      terrainLevel: terrainLevel >= 0 ? terrainLevel : null,
      terrainErrorPx: errors[2] ?? 0,
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

/** Resource counters of a globe without a renderer (before it starts, after it is destroyed). */
export const NO_RESOURCES: ResourceCounts = Object.freeze({
  meshes: 0,
  textures: 0,
  gpuBytes: 0,
  vertexArrays: 0,
  contexts: 0,
});

/** Renderer counters before a renderer exists. */
export const NO_RENDERER_STATS: RendererStats = Object.freeze({
  drawCalls: 0,
  triangles: 0,
  textureUploads: 0,
  meshUploads: 0,
  matrixUpdates: 0,
  pipelineCompiles: 0,
  pipelineSwitches: 0,
  compressedTextures: 0,
  gpuFrameMs: null,
});

/** Loader counters at zero, for `ImageryLoader.addStats` to add to. */
export function emptyLoaderStats(): ImageryLoaderStats {
  return {
    queued: 0,
    loading: 0,
    decoding: 0,
    ready: 0,
    failed: 0,
    noData: 0,
    requested: 0,
    uploads: 0,
    uploadMsLastFrame: 0,
    uploadBytesLastFrame: 0,
    uploadsPending: 0,
    pinnedSettled: 0,
    pinnedTotal: 0,
  };
}

/** `Globe.terrainStats()` from the terrain loader's counters, the upload budget and the last frame's terrain time. */
export function terrainStatsOf(
  loader: ImageryLoaderStats,
  uploadBudgetBytes: number,
  msLastFrame: number,
): TerrainStats {
  return {
    queued: loader.queued,
    loading: loader.loading,
    decoding: loader.decoding,
    ready: loader.ready,
    failed: loader.failed,
    noData: loader.noData,
    requested: loader.requested,
    uploads: loader.uploads,
    uploadMsLastFrame: loader.uploadMsLastFrame,
    uploadBytesLastFrame: loader.uploadBytesLastFrame,
    uploadsPending: loader.uploadsPending,
    uploadBudgetBytes,
    msLastFrame,
  };
}
