import type { DrawList } from '../imagery/draw-list.js';
import { MERCATOR_ROOT, type QuadtreeTile } from '../surface/surface-quadtree.hot.js';
import { sampleHeight } from './sample-height.js';
import type { TerrainHeights } from './terrain-heights.js';

/** Mercator y of a latitude, in units of the whole map's height (0 at the north edge, 1 at the south). */
function mercatorY(latRad: number): number {
  return (1 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / Math.PI) / 2;
}

/** The height of one draw layer's grid at tile coordinates, through transform `at` of `transforms`. */
function layerHeight(
  heights: TerrainHeights,
  handle: number,
  transforms: Float32Array,
  at: number,
  u: number,
  v: number,
): number {
  const grid = handle >= 0 ? heights.grid(handle) : undefined;
  // A tile drawn without terrain lies on the ellipsoid; NaN tells the caller nothing resident is shown there.
  if (!grid) return Number.NaN;
  const tu = u * (transforms[at] ?? 1) + (transforms[at + 2] ?? 0);
  const tv = v * (transforms[at + 1] ?? 1) + (transforms[at + 3] ?? 0);
  return sampleHeight(grid, tu, tv);
}

/**
 * The height of the surface as the frame shows it at a position (ADR 0006 §4): the drawn tile containing it, its
 * terrain and the terrain it morphs from, mixed by the morph's progress, exactly as the vertex shader does at the
 * tile's vertices. NaN where no drawn tile contains the position, or the tile containing it shows no terrain. Allocates
 * nothing.
 */
export function displayedHeightMeters(
  list: DrawList,
  tiles: readonly QuadtreeTile[],
  heights: TerrainHeights,
  lonRad: number,
  latRad: number,
): number {
  const terrain = list.terrain;
  for (let i = 0; i < list.count; i++) {
    const tile = tiles[i];
    if (!tile || lonRad < tile.westRad || lonRad > tile.eastRad || latRad < tile.southRad || latRad > tile.northRad)
      continue;
    const u = (lonRad - tile.westRad) / (tile.eastRad - tile.westRad);
    const vGeographic = (tile.northRad - latRad) / (tile.northRad - tile.southRad);
    let vOwn = vGeographic;
    if (tile.root === MERCATOR_ROOT) {
      const top = mercatorY(tile.northRad);
      vOwn = (mercatorY(latRad) - top) / (mercatorY(tile.southRad) - top);
    }
    const at = i * 4;
    const to = layerHeight(
      heights,
      terrain.textures[i] ?? -1,
      terrain.uvTransforms,
      at,
      u,
      terrain.geographic[i] === 1 ? vGeographic : vOwn,
    );
    const fade = terrain.fades[i] ?? 1;
    if (fade >= 1) return to;
    const from = layerHeight(
      heights,
      terrain.fromTextures[i] ?? -1,
      terrain.fromUvTransforms,
      at,
      u,
      terrain.fromGeographic[i] === 1 ? vGeographic : vOwn,
    );
    // Mid-morph, a side without terrain is the ellipsoid, as the shader draws it.
    const fromMeters = from === from ? from : 0;
    const toMeters = to === to ? to : 0;
    return fromMeters + (toMeters - fromMeters) * fade;
  }
  return Number.NaN;
}
