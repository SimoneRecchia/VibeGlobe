// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { LonLat } from './format.js';

const METERS_PER_DEGREE = 111_320;
const DEG = Math.PI / 180;
const MAX_LINES = 2000;

/** Options of {@link gridLines}. */
export interface GridLinesOptions {
  /** The grid's center. */
  readonly center: LonLat;
  /** How far the grid reaches from its center on each side, meters. */
  readonly halfSizeM: number;
  /** Meters between lines. */
  readonly spacingM: number;
  /** The bearing one family of lines runs along, degrees (default 0: north–south and east–west lines). */
  readonly bearingDeg?: number;
}

/**
 * A square grid of lines on the ground (F659), such as an editor's backdrop: two families of straight segments
 * `spacingM` apart through `center`, turned to `bearingDeg`, each segment as its two ends. At most 2000 lines: a finer
 * grid over a larger square is cut down to that by widening the spacing by whole multiples.
 *
 * @throws RangeError when `spacingM` is not a positive number of meters.
 */
export function gridLines(options: GridLinesOptions): [LonLat, LonLat][] {
  const { center, halfSizeM } = options;
  // Widening a spacing of zero never ends (KB-324).
  if (!(options.spacingM > 0))
    throw new RangeError(`gridLines: spacingM must be a positive number of meters, not ${String(options.spacingM)}`);
  let spacing = options.spacingM;
  while ((2 * (2 * halfSizeM)) / spacing > MAX_LINES) spacing *= 2;
  const kx = METERS_PER_DEGREE * Math.cos(center.latitudeDeg * DEG);
  const bearing = (options.bearingDeg ?? 0) * DEG;
  const along: [number, number] = [Math.sin(bearing), Math.cos(bearing)];
  const across: [number, number] = [Math.cos(bearing), -Math.sin(bearing)];
  const at = (a: number, b: number): LonLat => ({
    longitudeDeg: center.longitudeDeg + (a * along[0] + b * across[0]) / kx,
    latitudeDeg: center.latitudeDeg + (a * along[1] + b * across[1]) / METERS_PER_DEGREE,
  });
  const lines: [LonLat, LonLat][] = [];
  const steps = Math.floor(halfSizeM / spacing);
  for (let k = -steps; k <= steps; k++) {
    const offset = k * spacing;
    lines.push([at(-halfSizeM, offset), at(halfSizeM, offset)], [at(offset, -halfSizeM), at(offset, halfSizeM)]);
  }
  return lines;
}
