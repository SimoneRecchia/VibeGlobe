// Deterministic imagery tiles for tests (M3 plan §4.1): generated on request, no network, no downloaded data (ADR
// 0015). Every channel stays at 40 or more and alpha at 255 (except the `holes` pattern's transparent cells), so neither
// the black test nor the transparent-pixel sentinel of the scenario detectors can match fixture imagery.
import { PNG } from 'pngjs';
import { earthPixel } from './earth.ts';

/**
 * The tiling schemes the fixture server cuts: EPSG:3857 XYZ, the two-root geographic pyramid, and EPSG:3857 tiles with
 * rows linear in latitude (a WMS asked in EPSG:4326 for each Web Mercator tile, KB-232).
 */
export type FixtureScheme = 'mercator' | 'geographic' | 'mercator-latitude';

/**
 * Patterns: `world` a smooth color field with grid lines that follow the level (continuous across tiles and levels);
 * `levels` the same tinted per level, so refinement is visible; `border` alternating colors per tile parity with a
 * 1 px edge stripe; `smooth` the color field alone, continuous across every tile edge (seam checks, F110, F111);
 * `tiles` alternating colors per tile parity, contrasting at every tile edge (F106); `stripes` one-texel dark and
 * light stripes, the worst case for aliasing (F107); `patches` each tile one color of {@link PATCH_COLORS} (F108);
 * `holes` the `world` colors with every other `checker` cell transparent (F242); `checker` a checkerboard of 1/4096 of the Web Mercator world, the same at every level and tile size (F240, F241);
 * `toned` the `smooth` field darker and warmer, scaled by {@link TONE_SCALE}, a source of another tone (F249);
 * `red`, `green`, `blue`, `shade` and `white` one color everywhere ({@link SOLID_COLORS}); `earth`, `earth-package`
 * and `earth-fine` the playground's Natural Earth base image in their tones (`earth.ts`, F636).
 */
export type FixturePattern =
  | 'world'
  | 'levels'
  | 'border'
  | 'smooth'
  | 'toned'
  | 'tiles'
  | 'stripes'
  | 'patches'
  | 'checker'
  | 'holes'
  | 'red'
  | 'green'
  | 'blue'
  | 'shade'
  | 'earth'
  | 'earth-package'
  | 'earth-fine';

/** The single colors of the `red`, `green`, `blue` and `shade` (a flat hillshade) patterns: layer stacking (F243–F246). */
export const SOLID_COLORS: Readonly<Record<string, readonly [number, number, number]>> = {
  red: [220, 60, 60],
  green: [60, 200, 60],
  blue: [60, 60, 220],
  shade: [128, 128, 128],
  // A service's filler outside its area, such as basemap.at's white tiles around Austria (KB-209).
  white: [255, 255, 255],
};

/** The per-channel scale of the `toned` pattern over `smooth`: another brightness and color balance (F249). */
export const TONE_SCALE: readonly [number, number, number] = [0.7, 0.85, 1.05];

/** A color of the `smooth` field in the `toned` pattern's tone. */
function toned(color: readonly [number, number, number]): [number, number, number] {
  return [
    Math.max(MIN_CHANNEL, Math.round(color[0] * TONE_SCALE[0])),
    Math.max(MIN_CHANNEL, Math.round(color[1] * TONE_SCALE[1])),
    Math.max(MIN_CHANNEL, Math.round(color[2] * TONE_SCALE[2])),
  ];
}

/** A tile request. */
export interface FixtureTile {
  pattern: FixturePattern;
  scheme: FixtureScheme;
  level: number;
  x: number;
  y: number;
  sizePx?: number;
}

const MAX_LAT = Math.atan(Math.sinh(Math.PI));
/** Cells of the `checker` pattern across the Web Mercator world. */
const CHECKER_CELLS = 4096;
/** Cells of the `holes` pattern across the Web Mercator world: large enough to show at regional zooms. */
const HOLE_CELLS = 256;

/** Whether a position falls in an even cell of a checkerboard of `cells` × `cells` over the Web Mercator world. */
function checkerCell(lonRad: number, latRad: number, cells: number): boolean {
  const mx = (lonRad + Math.PI) / (2 * Math.PI);
  const my = (1 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / Math.PI) / 2;
  return (Math.floor(mx * cells) + Math.floor(my * cells)) % 2 === 0;
}
const MIN_CHANNEL = 40;

/** The longitude and latitude (radians) of a point of a tile, `u` and `v` from 0 to 1 across it (v from the north). */
export function fixturePosition(tile: FixtureTile, u: number, v: number): { lonRad: number; latRad: number } {
  const n = 2 ** tile.level;
  if (tile.scheme === 'mercator' || tile.scheme === 'mercator-latitude') {
    const lonRad = -Math.PI + (2 * Math.PI * (tile.x + u)) / n;
    const latAt = (row: number): number => Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n)));
    const latRad =
      tile.scheme === 'mercator' ? latAt(tile.y + v) : latAt(tile.y) + (latAt(tile.y + 1) - latAt(tile.y)) * v;
    return { lonRad, latRad: Math.max(-MAX_LAT, Math.min(MAX_LAT, latRad)) };
  }
  const lonRad = -Math.PI + (Math.PI * (tile.x + u)) / n;
  const latRad = Math.PI / 2 - (Math.PI * (tile.y + v)) / n;
  return { lonRad, latRad };
}

/** The `world` color at a position: smooth over the globe, each channel 40–240. */
export function worldColor(lonRad: number, latRad: number): [number, number, number] {
  const r = 0.5 + 0.5 * Math.sin(lonRad);
  const g = 0.5 + 0.5 * Math.sin(2 * latRad);
  const b = 0.5 + 0.5 * Math.cos(lonRad + latRad);
  return [MIN_CHANNEL + Math.round(200 * r), MIN_CHANNEL + Math.round(200 * g), MIN_CHANNEL + Math.round(200 * b)];
}

/** The level tints of the `levels` pattern, each channel at least 40. */
const LEVEL_TINTS: readonly (readonly [number, number, number])[] = [
  [255, 120, 120],
  [120, 255, 120],
  [120, 120, 255],
  [255, 255, 120],
  [255, 120, 255],
  [120, 255, 255],
];

/** The sRGB colors of the `patches` pattern: a tile at (x, y) shows color `(x + 3y) mod 8`. */
export const PATCH_COLORS: readonly (readonly [number, number, number])[] = [
  [230, 40, 40],
  [40, 200, 60],
  [50, 70, 230],
  [128, 128, 128],
  [240, 220, 60],
  [60, 200, 220],
  [200, 70, 200],
  [64, 64, 64],
];

/** Renders a tile's RGBA pixels, rows from the north. */
export function renderTile(tile: FixtureTile): Uint8Array {
  const size = tile.sizePx ?? 256;
  const rgba = new Uint8Array(size * size * 4);
  const tint = LEVEL_TINTS[tile.level % LEVEL_TINTS.length] ?? [255, 255, 255];
  // Grid lines every eighth of a tile at this level: they stay where they are when the level changes by one.
  const linesPerTile = 8;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const u = (i + 0.5) / size;
      const v = (j + 0.5) / size;
      let color: [number, number, number];
      let alpha = 255;
      const solid = SOLID_COLORS[tile.pattern];
      if (solid) {
        color = [...solid];
      } else if (tile.pattern === 'border' || tile.pattern === 'tiles') {
        const edge = tile.pattern === 'border' && (i === 0 || j === 0 || i === size - 1 || j === size - 1);
        const odd = (tile.x + tile.y) % 2 === 1;
        color = edge ? [240, 240, 40] : odd ? [60, 60, 200] : [200, 60, 60];
      } else if (tile.pattern === 'stripes') {
        const value = i % 2 === 0 ? 240 : MIN_CHANNEL;
        color = [value, value, value];
      } else if (tile.pattern === 'checker' || tile.pattern === 'holes') {
        const { lonRad, latRad } = fixturePosition(tile, u, v);
        const dark = checkerCell(lonRad, latRad, tile.pattern === 'holes' ? HOLE_CELLS : CHECKER_CELLS);
        if (tile.pattern === 'holes') {
          color = worldColor(lonRad, latRad);
          if (dark) alpha = 0;
        } else color = dark ? [60, 70, 90] : [230, 220, 200];
      } else if (tile.pattern === 'patches') {
        color = [...(PATCH_COLORS[(tile.x + 3 * tile.y) % PATCH_COLORS.length] ?? [128, 128, 128])];
      } else if (tile.pattern === 'smooth' || tile.pattern === 'toned' || tile.pattern.startsWith('earth')) {
        const { lonRad, latRad } = fixturePosition(tile, u, v);
        color = tile.pattern.startsWith('earth')
          ? earthPixel(tile.pattern, lonRad, latRad)
          : worldColor(lonRad, latRad);
        if (tile.pattern === 'toned') color = toned(color);
      } else {
        const { lonRad, latRad } = fixturePosition(tile, u, v);
        color = worldColor(lonRad, latRad);
        const onLine =
          Math.floor((i * linesPerTile) / size) !== Math.floor(((i + 1) * linesPerTile) / size) ||
          Math.floor((j * linesPerTile) / size) !== Math.floor(((j + 1) * linesPerTile) / size);
        if (onLine) color = [MIN_CHANNEL, MIN_CHANNEL, MIN_CHANNEL];
        if (tile.pattern === 'levels') {
          color = [
            Math.max(MIN_CHANNEL, Math.round((color[0] * tint[0]) / 255)),
            Math.max(MIN_CHANNEL, Math.round((color[1] * tint[1]) / 255)),
            Math.max(MIN_CHANNEL, Math.round((color[2] * tint[2]) / 255)),
          ];
        }
      }
      const k = (j * size + i) * 4;
      rgba[k] = color[0];
      rgba[k + 1] = color[1];
      rgba[k + 2] = color[2];
      rgba[k + 3] = alpha;
    }
  }
  return rgba;
}

/** True when a tile exists in its scheme's pyramid. */
export function tileExists(tile: FixtureTile): boolean {
  const n = 2 ** tile.level;
  const columns = tile.scheme === 'geographic' ? 2 * n : n;
  return (
    Number.isInteger(tile.level) &&
    tile.level >= 0 &&
    tile.level <= 24 &&
    Number.isInteger(tile.x) &&
    Number.isInteger(tile.y) &&
    tile.x >= 0 &&
    tile.y >= 0 &&
    tile.x < columns &&
    tile.y < n
  );
}

/** Encodes a tile as PNG. */
export function encodeTilePng(tile: FixtureTile): Buffer {
  const size = tile.sizePx ?? 256;
  const png = new PNG({ width: size, height: size });
  png.data = Buffer.from(renderTile(tile));
  return PNG.sync.write(png);
}
