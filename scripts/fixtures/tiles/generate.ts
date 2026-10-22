// Deterministic imagery tiles for tests (M3 plan §4.1): generated on request, no network, no downloaded data (ADR
// 0015). Every channel stays at 40 or more and alpha at 255, so neither the black test nor the transparent-pixel
// sentinel of the scenario detectors can match fixture imagery.
import { PNG } from 'pngjs';

/** The tiling schemes the fixture server cuts (EPSG:3857 XYZ and the two-root geographic pyramid). */
export type FixtureScheme = 'mercator' | 'geographic';

/**
 * Patterns: `world` a smooth color field with grid lines that follow the level (continuous across tiles and levels);
 * `levels` the same tinted per level, so refinement is visible; `border` alternating colors per tile parity with a
 * 1 px edge stripe; `smooth` the color field alone, continuous across every tile edge (seam checks, F110, F111);
 * `tiles` alternating colors per tile parity, contrasting at every tile edge (F106); `stripes` one-texel dark and
 * light stripes, the worst case for aliasing (F107); `patches` each tile one color of {@link PATCH_COLORS} (F108).
 */
export type FixturePattern = 'world' | 'levels' | 'border' | 'smooth' | 'tiles' | 'stripes' | 'patches';

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
const MIN_CHANNEL = 40;

/** The longitude and latitude (radians) of a point of a tile, `u` and `v` from 0 to 1 across it (v from the north). */
export function fixturePosition(tile: FixtureTile, u: number, v: number): { lonRad: number; latRad: number } {
  const n = 2 ** tile.level;
  if (tile.scheme === 'mercator') {
    const lonRad = -Math.PI + (2 * Math.PI * (tile.x + u)) / n;
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (tile.y + v)) / n)));
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
      if (tile.pattern === 'border' || tile.pattern === 'tiles') {
        const edge = tile.pattern === 'border' && (i === 0 || j === 0 || i === size - 1 || j === size - 1);
        const odd = (tile.x + tile.y) % 2 === 1;
        color = edge ? [240, 240, 40] : odd ? [60, 60, 200] : [200, 60, 60];
      } else if (tile.pattern === 'stripes') {
        const value = i % 2 === 0 ? 240 : MIN_CHANNEL;
        color = [value, value, value];
      } else if (tile.pattern === 'patches') {
        color = [...(PATCH_COLORS[(tile.x + 3 * tile.y) % PATCH_COLORS.length] ?? [128, 128, 128])];
      } else if (tile.pattern === 'smooth') {
        const { lonRad, latRad } = fixturePosition(tile, u, v);
        color = worldColor(lonRad, latRad);
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
      rgba[k + 3] = 255;
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
