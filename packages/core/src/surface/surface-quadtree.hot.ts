// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * @hotpath Runs every frame over every visited tile; doubles never cross a call boundary here, because V8 boxes doubles
 * passed to or returned from a call it does not inline (ADR 0018).
 * @benchmark benchmarks/run.ts
 */
import type { Camera } from '../camera/camera.js';
import { WGS84 } from '../geodesy/wgs84.js';
import { WEB_MERCATOR_MAX_LATITUDE_RAD } from '../projections/web-mercator.js';
import { MAX_TILE_LEVEL } from '../tiling/tile-key.js';
import { cappedMercatorInto, wrapDeltaInto, type MorphFrame } from '../view/morph.js';
import { fogVisibilityInto } from './fog.js';

/** ADR 0006 §1: the surface is one Web Mercator quadtree plus two geographic polar caps. This is the Mercator root. */
export const MERCATOR_ROOT = 0;
/** The geographic cap from the Web Mercator limit (85.0511°N) to the north pole. */
export const NORTH_CAP = 1;
/** The geographic cap from the south pole to the Web Mercator limit (85.0511°S). */
export const SOUTH_CAP = 2;

/** Grid segments per tile edge, as M2's surface (ADR 0013): the mesh and its geometric error agree on it. */
export const QUADTREE_SEGMENTS = 16;

/** Visibility below which fog hides a surface entirely: under one 8-bit step of its color (F574). */
export const FULL_FOG_VISIBILITY = 1 / 255;

/**
 * A surface tile of the three-root quadtree. Mercator tiles are XYZ tiles (rows from the north); cap tiles are
 * geographic, rows from the cap's northern edge, and may cover `span` columns of their level near the pole.
 */
export interface QuadtreeTile {
  key: number;
  root: 0 | 1 | 2;
  level: number;
  x: number;
  y: number;
  span: number;
  westRad: number;
  southRad: number;
  eastRad: number;
  northRad: number;
  /** The selection found the tile's closest point in full fog (F574): nothing finer than it is wanted there. */
  fogged?: boolean;
}

/** Selection settings. */
export interface QuadtreeSelectionOptions {
  /** The frame's globe-to-flat morph (ADR 0008): tiles are measured and culled where the frame draws them. */
  morph?: MorphFrame | undefined;
  /** Largest allowed geometric error on screen, in pixels. */
  maxScreenErrorPx: number;
  /** Deepest level, at most {@link MAX_TILE_LEVEL}. */
  maxLevel: number;
  /** Coarsest level drawn (default and minimum 2): every visible tile is refined at least to it. */
  minLevel?: number;
  /**
   * Texels along a tile edge of the finest imagery layer (tile size × pixel ratio), or 0 without imagery. A tile is
   * refined while one of its texels covers more than {@link QuadtreeSelectionOptions.maxTexelErrorPx} screen pixels,
   * up to {@link QuadtreeSelectionOptions.imageryMaxLevel} (F081, ADR 0006 §2).
   */
  imageryTexelsPerTile?: number;
  /** The finest level the imagery layers serve; texels do not refine beyond it. */
  imageryMaxLevel?: number;
  /** Largest texel size on screen, in pixels (ADR 0006's τ_imagery); default 1.5. */
  maxTexelErrorPx?: number;
  /**
   * Terrain (M4, ADR 0006 §2): the geometric error in meters of the terrain a surface tile of each level shows, indexed
   * by level (undefined without terrain). A tile refines while this error exceeds {@link maxTerrainErrorPx} pixels, up
   * to {@link terrainMaxLevel}.
   */
  terrainErrorMeters?: Float64Array | undefined;
  /**
   * The terrain is tiled in Web Mercator: its error per level, given at the equator, shrinks with the cosine of a tile's
   * latitude like its ground spacing, and polar cap tiles, which continue its edge row, never refine for it.
   */
  terrainMercator?: boolean;
  /** The deepest surface level whose terrain is finer than its parent's. */
  terrainMaxLevel?: number;
  /** ADR 0006's τ_terrain, in render-target pixels; default 2. */
  maxTerrainErrorPx?: number;
  /**
   * The lowest and highest terrain heights the surface may show, meters: bounding volumes reach from one to the other,
   * so culling never removes visible relief (F142). Both 0 without terrain.
   */
  terrainMinMeters?: number;
  terrainMaxMeters?: number;
  /**
   * The height range of one tile's relief, written as [min, max, error] meters into `out`: the heights of the terrain
   * it shows so far and how much finer levels may add; then in `out[3]` the deepest level its terrain is worth refining
   * to (beyond the source's finest level, where the surface samples every vertex of that grid). False when unknown (no
   * terrain resident there, and the global range applies). A tile's distance is measured from its own highest relief, and culling uses its range widened by
   * the error but never beyond the global range, so one high peak does not refine or keep every tile near a low eye
   * (KB-077).
   */
  terrainRange?: ((tile: QuadtreeTile, out: Float64Array) => boolean) | undefined;
  /**
   * The atmosphere's haze while fog is on (F395, ADR 0040), undefined otherwise: a tile's errors are multiplied by the
   * fraction of light from its nearest point that reaches the eye, so hazed tiles near the horizon stay coarse.
   */
  fogHaze?: number | undefined;
  /** Written by each selection: tiles skipped as outside the view frustum (F086) and beyond the horizon (F087). */
  culledByFrustum?: number;
  culledByHorizon?: number;
}

const MIN_LEVEL = 2;
/** ADR 0004: a chunk's radius stays below this multiple of its distance from the eye, so float32 offsets stay exact. */
const RADIUS_TO_DISTANCE = 1000;
const A = WGS84.semiMajorAxisMeters;
const B = WGS84.semiMinorAxisMeters;
const E2 = WGS84.firstEccentricitySquared;
const MAX_LAT = WEB_MERCATOR_MAX_LATITUDE_RAD;
const CAP_HEIGHT = Math.PI / 2 - MAX_LAT;

/** A tile key unique across the three roots: `packTileKey` written out, since a key above 31 bits would be boxed. */
export function quadtreeTileKey(root: number, level: number, x: number, y: number): number {
  return (((4 ** level - 1) / 3 + y * 2 ** level + x) * 3 + root) as number;
}

/** The latitude of a Web Mercator row edge, `row` of `rows` rows from the north (rows may be fractional). */
function mercatorRowLatitudeRad(row: number, rows: number): number {
  if (row <= 0) return MAX_LAT;
  if (row >= rows) return -MAX_LAT;
  return Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / rows)));
}

/**
 * The latitude of mesh row `row` (0 to {@link QUADTREE_SEGMENTS}, north to south) of a tile: Mercator tiles space
 * their rows evenly in Mercator y, so Mercator imagery maps linearly onto each triangle; cap tiles in latitude.
 */
export function quadtreeRowLatitudeRad(tile: QuadtreeTile, row: number): number {
  if (tile.root === MERCATOR_ROOT) {
    const rows = 2 ** tile.level;
    return mercatorRowLatitudeRad(tile.y + row / QUADTREE_SEGMENTS, rows);
  }
  return tile.northRad + ((tile.southRad - tile.northRad) * row) / QUADTREE_SEGMENTS;
}

/** Fills a tile's key and bounds from its root, level, first column, row and column span; returns `out`. */
export function quadtreeTileBounds(
  root: 0 | 1 | 2,
  level: number,
  x: number,
  y: number,
  span: number,
  out: QuadtreeTile,
): QuadtreeTile {
  const n = 2 ** level;
  out.key = (((4 ** level - 1) / 3 + y * n + x) * 3 + root) as number;
  out.root = root;
  out.level = level;
  out.x = x;
  out.y = y;
  out.span = span;
  out.westRad = -Math.PI + (2 * Math.PI * x) / n;
  out.eastRad = x + span === n ? Math.PI : -Math.PI + (2 * Math.PI * (x + span)) / n;
  if (root === MERCATOR_ROOT) {
    // mercatorRowLatitudeRad written out: a double returned from a call is boxed (ADR 0018).
    out.northRad = y === 0 ? MAX_LAT : Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
    out.southRad = y + 1 === n ? -MAX_LAT : Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)));
  } else {
    const top = root === NORTH_CAP ? Math.PI / 2 : -MAX_LAT;
    out.northRad = y === 0 ? top : top - (CAP_HEIGHT * y) / n;
    out.southRad = y + 1 === n ? top - CAP_HEIGHT : top - (CAP_HEIGHT * (y + 1)) / n;
  }
  return out;
}

/** The 3 × 3 grid of tile corners, edge midpoints and center on the ellipsoid, ECEF: the center is point 4. */
const grid = new Float64Array(27);
const lonSin = new Float64Array(3);
const lonCos = new Float64Array(3);
/** The tile center relative to the eye. */
const offset = new Float64Array(3);
/** The fog test's distance and haze in, its visibility out (see {@link fogVisibilityInto}). */
const fog = new Float64Array(3);
/** The ellipsoid normal at the tile center. */
const normal = new Float64Array(3);
/** Per-tile measures written by measureTile. */
const measure = new Float64Array(4);
const RADIUS = 0;
const CLOSEST = 1;
const SAG = 2;
/** Ground size of one imagery texel on the tile, meters (0 without imagery). */
const TEXEL = 3;
/**
 * A tile's relief: [min, max] meters for its distance, then [min, max] for culling (widened by the error of what it
 * shows, within the global range); from {@link QuadtreeSelectionOptions.terrainRange}.
 */
const tileRange = new Float64Array(4);
/**
 * Per-tile terrain measures, in an array because a double stored in a module variable or returned from a call is boxed
 * (ADR 0018).
 */
const relief = new Float64Array(7);
/** The deepest level the tile's terrain is worth refining to (from {@link QuadtreeSelectionOptions.terrainRange}). */
const LEVEL_LIMIT = 0;
/** The share of the level's terrain error a tile shows (latitude scaling of Mercator terrain), set by measureTile. */
const ERROR_SCALE = 1;
/** The lower bound of the eye's distance to the tile's relief, set by reliefDistance. */
const DISTANCE = 2;
/**
 * How much of a terrain height the frame draws on the tile (ADR 0008): the relief factor, times σ·k(φ) on the flat map
 * (the poleward edge's, the largest), set by measureTile.
 */
const HEIGHT_SCALE = 3;
/** The great-circle angle from the morph's anchor to the tile's nearest point, radians, set by measureTile. */
const ANCHOR_ANGLE = 4;
/** The frame's morph factor, set by measureTile. */
const MORPH = 5;
/** The camera's tilt, radians, set once per selection. */
const TILT = 6;

/**
 * Writes a tile's relief range into {@link tileRange}: its own when known, else the whole terrain's, with the
 * ellipsoid (0) always inside it, since a tile without terrain lies on it.
 */
function measureRelief(tile: QuadtreeTile, options: QuadtreeSelectionOptions): void {
  const globalLow = options.terrainMinMeters ?? 0;
  const globalHigh = options.terrainMaxMeters ?? 0;
  relief[LEVEL_LIMIT] = options.terrainMaxLevel ?? 0;
  if (options.terrainRange?.(tile, tileRange)) {
    // At the source's finest level the tile's own grid sets how deep its terrain is worth refining (ADR 0028).
    const limit = tileRange[3] ?? Number.POSITIVE_INFINITY;
    if (limit !== Number.POSITIVE_INFINITY) relief[LEVEL_LIMIT] = limit;
    const error = tileRange[2] ?? 0;
    const low = (tileRange[0] ?? 0) - error;
    const high = (tileRange[1] ?? 0) + error;
    tileRange[2] = low > globalLow ? low : globalLow;
    tileRange[3] = high < globalHigh ? high : globalHigh;
  } else {
    tileRange[0] = tileRange[2] = globalLow;
    tileRange[1] = tileRange[3] = globalHigh;
  }
  for (let i = 0; i < 4; i += 2) {
    if ((tileRange[i] ?? 0) > 0) tileRange[i] = 0;
    if ((tileRange[i + 1] ?? 0) < 0) tileRange[i + 1] = 0;
  }
  // Heights as the frame draws them: scaled by the relief factor, and by σ·k on the flat map (ADR 0008).
  const scale = relief[HEIGHT_SCALE] ?? 1;
  for (let i = 0; i < 4; i++) tileRange[i] = (tileRange[i] ?? 0) * scale;
}

/**
 * A lower bound of the distance from the eye to the tile's relief (measured by measureTile and measureRelief), never
 * below the bounding sphere's: in the tangent plane at the tile center, the eye's lateral distance beyond the tile's
 * radius and its height outside the relief's range (KB-080). Everything on the tile lies within its radius of the
 * center laterally (plus what the relief's tilted normals add) and, since the ellipsoid is convex, at or below the
 * tangent plane by at most radius² / A plus the chord sag, before the relief raises it.
 */
function reliefDistance(): void {
  const high = tileRange[1] ?? 0;
  const sphere = (measure[CLOSEST] ?? 0) - high;
  // Without terrain the surface is the ellipsoid, where the sphere's bound has always measured the selection.
  if (state.options.terrainRange === undefined) {
    relief[DISTANCE] = sphere;
    return;
  }
  const radius = measure[RADIUS] ?? 0;
  const ox = offset[0] ?? 0;
  const oy = offset[1] ?? 0;
  const oz = offset[2] ?? 0;
  // The eye's height above the tangent plane, and its lateral distance from the center.
  const above = -(ox * (normal[0] ?? 0) + oy * (normal[1] ?? 0) + oz * (normal[2] ?? 0));
  const lateralSquared = ox * ox + oy * oy + oz * oz - above * above;
  const lateral = lateralSquared > 0 ? Math.sqrt(lateralSquared) : 0;
  const low = tileRange[0] ?? 0;
  const reach = (high > -low ? high : -low) * (radius / A);
  const gap = lateral - radius - reach;
  const bottom = low - (radius * radius) / A - (measure[SAG] ?? 0) - reach;
  const rise = above > high ? above - high : above < bottom ? bottom - above : 0;
  const shell = gap > 0 ? Math.sqrt(gap * gap + rise * rise) : rise;
  relief[DISTANCE] = shell > sphere ? shell : sphere;
}

/** The eye's horizon vector w = (x/a², y/a², z/b²) and its length, set once per selection. */
const horizon = new Float64Array(4);

/** Traversal state, module-level so the recursion allocates nothing. */
const state: {
  camera: Camera | undefined;
  options: QuadtreeSelectionOptions;
  out: QuadtreeTile[] | undefined;
  count: number;
  pixelsPerRadian: number;
} = { camera: undefined, options: { maxScreenErrorPx: 1, maxLevel: 1 }, out: undefined, count: 0, pixelsPerRadian: 1 };

/**
 * Chooses the surface tiles to draw for a camera over the three roots (ADR 0006 §1): frustum and horizon culling,
 * then refinement while the projected geometric error exceeds the limit or the tile is too large for its distance
 * (ADR 0004). Fills `out` and returns the count; reuses the records in `out`, so steady-state selection allocates
 * nothing.
 */
export function selectQuadtreeTiles(camera: Camera, options: QuadtreeSelectionOptions, out: QuadtreeTile[]): number {
  state.camera = camera;
  state.options = options;
  state.out = out;
  state.count = 0;
  options.culledByFrustum = 0;
  options.culledByHorizon = 0;
  state.pixelsPerRadian = camera.heightPx / (2 * Math.tan(camera.fovYRad / 2));
  relief[TILT] = camera.pose.tiltRad;
  const eye = camera.eyeEcef;
  horizon[0] = (eye[0] ?? 0) / (A * A);
  horizon[1] = (eye[1] ?? 0) / (A * A);
  horizon[2] = (eye[2] ?? 0) / (B * B);
  horizon[3] = Math.sqrt((horizon[0] ?? 0) ** 2 + (horizon[1] ?? 0) ** 2 + (horizon[2] ?? 0) ** 2);
  visit(MERCATOR_ROOT, 0, 0, 0, 1);
  visit(NORTH_CAP, 0, 0, 0, 1);
  visit(SOUTH_CAP, 0, 0, 0, 1);
  state.out = undefined;
  return state.count;
}

/**
 * Visits a tile. Mercator tiles always split into four. Cap tiles follow ADR 0006's cap rule (KB-043): four children
 * while the tile's east–west width at its equatorward edge is at least half its north–south height, else two children
 * in latitude only, each covering twice the columns, so tiles near a pole stay wedges and their count stays bounded.
 */
function visit(root: 0 | 1 | 2, level: number, x: number, y: number, span: number): void {
  const { camera, options, out } = state;
  if (!camera || !out) return;
  const tile = (out[state.count] ??= {
    key: 0,
    root: 0,
    level: 0,
    x: 0,
    y: 0,
    span: 1,
    westRad: 0,
    southRad: 0,
    eastRad: 0,
    northRad: 0,
    fogged: false,
  });
  quadtreeTileBounds(root, level, x, y, span, tile);
  measureTile(tile, camera.eyeEcef);
  const radius = measure[RADIUS] ?? 0;
  // Comparisons, not Math.max, here and below: code not yet fully optimized calls it with boxed doubles.
  // Relief can rise toward the eye by up to the tile's highest terrain (F142).
  measureRelief(tile, options);
  reliefDistance();
  const closest = relief[DISTANCE] ?? 0;
  const distance = closest > camera.nearMeters ? closest : camera.nearMeters;
  if (level >= MIN_LEVEL) {
    if (outsideFrustum(camera)) {
      options.culledByFrustum = (options.culledByFrustum ?? 0) + 1;
      return;
    }
    if (beyondHorizon()) {
      options.culledByHorizon = (options.culledByHorizon ?? 0) + 1;
      return;
    }
  }
  // Errors divided by the distance, the distance divided by the fog's visibility: hazed tiles count as farther (F395).
  let errorDistance = distance;
  // A tile whose closest point is in full fog is never refined: nothing of its detail would show (F574).
  let fogged = false;
  if (options.fogHaze !== undefined) {
    fog[0] = closest;
    fog[1] = options.fogHaze;
    fogVisibilityInto(camera.eyeEcef, offset, fog);
    const visibility = fog[2] ?? 1;
    errorDistance = distance / (visibility > 1e-3 ? visibility : 1e-3);
    fogged = visibility < FULL_FOG_VISIBILITY;
  }
  const screenError = ((measure[SAG] ?? 0) / errorDistance) * state.pixelsPerRadian;
  const maxLevel = options.maxLevel < MAX_TILE_LEVEL ? options.maxLevel : MAX_TILE_LEVEL;
  const refine =
    level < (options.minLevel ?? MIN_LEVEL) ||
    (level < maxLevel &&
      !fogged &&
      (screenError > options.maxScreenErrorPx ||
        radius > RADIUS_TO_DISTANCE * distance ||
        (level < (options.imageryMaxLevel ?? 0) &&
          ((measure[TEXEL] ?? 0) / errorDistance) * state.pixelsPerRadian > (options.maxTexelErrorPx ?? 1.5)) ||
        (level < (relief[LEVEL_LIMIT] ?? 0) &&
          (((options.terrainErrorMeters?.[level] ?? 0) * (relief[ERROR_SCALE] ?? 1) * (relief[HEIGHT_SCALE] ?? 1)) /
            errorDistance) *
            state.pixelsPerRadian >
            (options.maxTerrainErrorPx ?? 2))));
  if (!refine) {
    tile.fogged = fogged;
    state.count++;
    return;
  }
  if (root === MERCATOR_ROOT || splitsInFour(tile)) {
    for (let child = 0; child < 4; child++) {
      visit(root, level + 1, 2 * x + (child & 1) * span, 2 * y + (child >> 1), span);
    }
  } else {
    visit(root, level + 1, 2 * x, 2 * y, 2 * span);
    visit(root, level + 1, 2 * x, 2 * y + 1, 2 * span);
  }
}

/**
 * The refinement errors of a tile as the selection measures them, in screen pixels: `out[0]` the geometric (chord sag)
 * error, `out[1]` the size of one imagery texel (0 without imagery), `out[2]` the error of the terrain its level shows
 * (0 without terrain). For diagnostics; not used per frame.
 */
export function quadtreeTileErrorsPx(
  camera: Camera,
  tile: QuadtreeTile,
  options: QuadtreeSelectionOptions,
  out: Float64Array,
): Float64Array {
  const previous = state.options;
  state.options = options;
  measureTile(tile, camera.eyeEcef);
  // The selection's distance: relief can rise toward the eye by up to the tile's highest terrain.
  measureRelief(tile, options);
  reliefDistance();
  const closest = relief[DISTANCE] ?? 0;
  state.options = previous;
  const distance = closest > camera.nearMeters ? closest : camera.nearMeters;
  const pixelsPerRadian = camera.heightPx / (2 * Math.tan(camera.fovYRad / 2));
  out[0] = ((measure[SAG] ?? 0) / distance) * pixelsPerRadian;
  out[1] = ((measure[TEXEL] ?? 0) / distance) * pixelsPerRadian;
  out[2] =
    (((options.terrainErrorMeters?.[tile.level] ?? 0) * (relief[ERROR_SCALE] ?? 1) * (relief[HEIGHT_SCALE] ?? 1)) /
      distance) *
    pixelsPerRadian;
  return out;
}

/** ADR 0006's cap rule for a cap tile: four children while its equatorward width is at least half its height. */
function splitsInFour(tile: QuadtreeTile): boolean {
  const north = tile.northRad;
  const south = tile.southRad;
  // Comparisons, not Math.min/abs, as above.
  const equatorward = south >= 0 ? south : north <= 0 ? -north : 0;
  return Math.cos(equatorward) * (tile.eastRad - tile.westRad) >= (north - south) / 2;
}

const mercatorXs = new Float64Array(3);
const mercatorYs = new Float64Array(3);
const lonLat = new Float64Array(2);
const xy = new Float64Array(2);
const delta = new Float64Array(3);
const plane = new Float64Array(3);
const wrap = new Float64Array(3);

/**
 * Moves the 3 × 3 grid of {@link measureTile} to where the frame draws it (ADR 0008): (1 − m)·globe + m·plane, the plane
 * points placed per tile at the world copy nearest the anchor; turns the center normal likewise, and sets the tile's
 * height scale and its angular distance from the anchor (for the horizon rule during the morph).
 */
function morphGrid(tile: QuadtreeTile, morph: MorphFrame): void {
  const m = morph.factors[0] ?? 0;
  const midLon = (tile.westRad + tile.eastRad) / 2;
  for (let i = 0; i < 3; i++) {
    lonLat[0] = i === 0 ? tile.westRad : i === 1 ? midLon : tile.eastRad;
    lonLat[1] = i === 0 ? tile.northRad : i === 1 ? (tile.southRad + tile.northRad) / 2 : tile.southRad;
    cappedMercatorInto(lonLat, xy);
    mercatorXs[i] = xy[0] ?? 0;
    mercatorYs[i] = xy[1] ?? 0;
  }
  wrap[0] = mercatorXs[1] ?? 0;
  wrap[1] = morph.anchorMercator[0] ?? 0;
  wrapDeltaInto(wrap);
  const centerDelta = wrap[2] ?? 0;
  const axes = morph.axes;
  // The angle between the tile's center normal and the anchor's up, less the tile's own angular radius.
  const cosine =
    (normal[0] ?? 0) * (axes[6] ?? 0) + (normal[1] ?? 0) * (axes[7] ?? 0) + (normal[2] ?? 0) * (axes[8] ?? 0);
  const halfWidth = (tile.eastRad - tile.westRad) / 2;
  const halfHeight = (tile.northRad - tile.southRad) / 2;
  const angle =
    Math.acos(cosine > 1 ? 1 : cosine < -1 ? -1 : cosine) - Math.sqrt(halfWidth * halfWidth + halfHeight * halfHeight);
  relief[ANCHOR_ANGLE] = angle > 0 ? angle : 0;
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      delta[0] = centerDelta + (mercatorXs[column] ?? 0) - (mercatorXs[1] ?? 0);
      delta[1] = (mercatorYs[row] ?? 0) - (morph.anchorMercator[1] ?? 0);
      delta[2] = 0;
      morph.planeFromDeltaInto(delta, plane);
      const point = (row * 3 + column) * 3;
      for (let i = 0; i < 3; i++) grid[point + i] = (1 - m) * (grid[point + i] ?? 0) + m * (plane[i] ?? 0);
    }
  }
  let length = 0;
  for (let i = 0; i < 3; i++) {
    normal[i] = (1 - m) * (normal[i] ?? 0) + m * (axes[6 + i] ?? 0);
    length += (normal[i] ?? 0) * (normal[i] ?? 0);
  }
  length = Math.sqrt(length);
  for (let i = 0; i < 3; i++) normal[i] = (normal[i] ?? 0) / length;
  // On the plane a height h is drawn σ·k(φ)·h high; the poleward edge has the largest k.
  const north = tile.northRad;
  const south = tile.southRad;
  // k(φ) = √(1 − e² sin² φ) / cos φ (morph.ts), written out for the poleward edge within the Mercator limit.
  const poleward = north > -south ? north : -south;
  const latRad = poleward < MAX_LAT ? poleward : MAX_LAT;
  const sinLat = Math.sin(latRad);
  const k = Math.sqrt(1 - E2 * sinLat * sinLat) / Math.cos(latRad);
  relief[HEIGHT_SCALE] = (morph.factors[1] ?? 1) * (1 - m + m * (morph.factors[2] ?? 1) * k);
}

/**
 * Measures a tile against the eye into `measure`: the radius of a sphere around it, the distance from the eye to that
 * sphere and the chord sag of its mesh; writes the center relative to the eye into `offset`.
 */
function measureTile(tile: QuadtreeTile, eye: Float64Array): void {
  const midLon = (tile.westRad + tile.eastRad) / 2;
  for (let column = 0; column < 3; column++) {
    const lon = column === 0 ? tile.westRad : column === 1 ? midLon : tile.eastRad;
    lonSin[column] = Math.sin(lon);
    lonCos[column] = Math.cos(lon);
  }
  for (let row = 0; row < 3; row++) {
    const lat = row === 0 ? tile.northRad : row === 1 ? (tile.southRad + tile.northRad) / 2 : tile.southRad;
    const sinLat = Math.sin(lat);
    if (row === 1) {
      const cosLat = Math.cos(lat);
      normal[0] = cosLat * (lonCos[1] ?? 0);
      normal[1] = cosLat * (lonSin[1] ?? 0);
      normal[2] = sinLat;
    }
    const primeVerticalRadius = A / Math.sqrt(1 - E2 * sinLat * sinLat);
    const r = primeVerticalRadius * Math.cos(lat);
    const z = primeVerticalRadius * (1 - E2) * sinLat;
    for (let column = 0; column < 3; column++) {
      const point = (row * 3 + column) * 3;
      grid[point] = r * (lonCos[column] ?? 0);
      grid[point + 1] = r * (lonSin[column] ?? 0);
      grid[point + 2] = z;
    }
  }
  const morph = state.options.morph;
  // The factors are read from the frame's arrays: a double that is a phi of a constant, or an argument, is boxed.
  relief[MORPH] = 0;
  relief[HEIGHT_SCALE] = 1;
  if (morph) {
    relief[MORPH] = morph.factors[0] ?? 0;
    relief[HEIGHT_SCALE] = morph.factors[1] ?? 1;
  }
  relief[ANCHOR_ANGLE] = 0;
  if (morph && (relief[MORPH] ?? 0) > 0) morphGrid(tile, morph);
  let radiusSquared = 0;
  for (let point = 0; point < 27; point += 3) {
    const dx = (grid[point] ?? 0) - (grid[12] ?? 0);
    const dy = (grid[point + 1] ?? 0) - (grid[13] ?? 0);
    const dz = (grid[point + 2] ?? 0) - (grid[14] ?? 0);
    const distanceSquared = dx * dx + dy * dy + dz * dz;
    if (distanceSquared > radiusSquared) radiusSquared = distanceSquared;
  }
  const north = tile.northRad;
  const south = tile.southRad;
  const equatorward = south >= 0 ? south : north <= 0 ? -north : 0;
  relief[ERROR_SCALE] =
    state.options.terrainMercator !== true ? 1 : tile.root === MERCATOR_ROOT ? Math.cos(equatorward) : 0;
  // The largest mesh row step: a Mercator tile's rows are densest toward the pole, so its widest step is the one at
  // its equatorward edge; a cap tile's rows are evenly spaced.
  let step = (north - south) / QUADTREE_SEGMENTS;
  if (tile.root === MERCATOR_ROOT) {
    const rows = 2 ** tile.level;
    const edgeRow = south >= 0 ? tile.y + 1 : tile.y;
    const nextRow = south >= 0 ? edgeRow - 1 / QUADTREE_SEGMENTS : edgeRow + 1 / QUADTREE_SEGMENTS;
    const edgeLat =
      edgeRow <= 0 ? MAX_LAT : edgeRow >= rows ? -MAX_LAT : Math.atan(Math.sinh(Math.PI * (1 - (2 * edgeRow) / rows)));
    const nextLat = Math.atan(Math.sinh(Math.PI * (1 - (2 * nextRow) / rows)));
    const mercatorStep = edgeLat > nextLat ? edgeLat - nextLat : nextLat - edgeLat;
    if (mercatorStep > step) step = mercatorStep;
  }
  const lonStep = (tile.eastRad - tile.westRad) / QUADTREE_SEGMENTS;
  // Chord sag of the grid below the ellipsoid along a meridian or along the equatorward parallel, whichever is larger.
  const meridianSag = (A * step * step) / 8;
  const parallelSag = (A * Math.cos(equatorward) * lonStep * lonStep) / 8;
  // On the flat map the mesh is exact (rows evenly spaced in Mercator y, columns in x): only the globe's share sags.
  const sag = (meridianSag > parallelSag ? meridianSag : parallelSag) * (1 - (relief[MORPH] ?? 0));
  const radius = Math.sqrt(radiusSquared) + sag;
  offset[0] = (grid[12] ?? 0) - (eye[0] ?? 0);
  offset[1] = (grid[13] ?? 0) - (eye[1] ?? 0);
  offset[2] = (grid[14] ?? 0) - (eye[2] ?? 0);
  measure[RADIUS] = radius;
  measure[CLOSEST] = Math.sqrt((offset[0] ?? 0) ** 2 + (offset[1] ?? 0) ** 2 + (offset[2] ?? 0) ** 2) - radius;
  measure[SAG] = sag;
  const texels = state.options?.imageryTexelsPerTile ?? 0;
  const midLat = (north + south) / 2;
  const widthMeters = A * Math.cos(midLat) * (tile.eastRad - tile.westRad);
  const heightMeters = A * (north - south);
  measure[TEXEL] = texels > 0 ? (widthMeters > heightMeters ? widthMeters : heightMeters) / texels : 0;
}

/** True when the tile's bounding sphere is entirely outside one of the frustum planes (F086). */
function outsideFrustum(camera: Camera): boolean {
  const planes = camera.frustumPlanes;
  const high = tileRange[3] ?? 0;
  const low = -(tileRange[2] ?? 0);
  // The sphere grown by the tile's relief range: every displaced vertex stays inside it (F142).
  const radius = (measure[RADIUS] ?? 0) + (high > low ? high : low);
  for (let plane = 0; plane < 5; plane++) {
    const signedDistance =
      (planes[plane * 4] ?? 0) * (offset[0] ?? 0) +
      (planes[plane * 4 + 1] ?? 0) * (offset[1] ?? 0) +
      (planes[plane * 4 + 2] ?? 0) * (offset[2] ?? 0) +
      (planes[plane * 4 + 3] ?? 0);
    if (signedDistance < -radius) return true;
  }
  return false;
}

/**
 * True when the whole tile lies beyond the horizon (F087): a point P of the ellipsoid is visible from the eye exactly
 * when P · w ≥ 1, with w = (Ex/a², Ey/a², Ez/b²), so a bounding sphere with center C and radius R shows nothing when
 * C · w + R |w| < 1 (KB-012). Terrain raises points by at most the highest terrain height.
 */
function beyondHorizon(): boolean {
  const m = relief[MORPH] ?? 0;
  if (m > 0) {
    // ADR 0008: from m = ½ on nothing is behind a horizon; before, tiles farther from the anchor than θ_s with
    // cos θ_s = −m / (1 − m), widened by the tilt, are.
    if (m >= 0.5) return false;
    const limit = Math.acos(-m / (1 - m)) + (relief[TILT] ?? 0);
    return (relief[ANCHOR_ANGLE] ?? 0) > limit;
  }
  // A point raised by h along its normal n gains h (n · w) ≤ h |w|: peaks behind the horizon stay drawn (F142).
  const high = tileRange[3] ?? 0;
  const reach =
    (grid[12] ?? 0) * (horizon[0] ?? 0) +
    (grid[13] ?? 0) * (horizon[1] ?? 0) +
    (grid[14] ?? 0) * (horizon[2] ?? 0) +
    ((measure[RADIUS] ?? 0) + (high > 0 ? high : 0)) * (horizon[3] ?? 0);
  return reach < 1;
}
