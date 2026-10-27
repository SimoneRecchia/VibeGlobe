// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { inCoverage, type ImagerySource, type TileCoord, type TileRectangleRad } from '@vibeglobe/core';

const DEG = Math.PI / 180;

/**
 * A coverage rectangle in radians from bounds in degrees, or undefined when the bounds are missing, inverted or cover
 * the whole world (then no coverage test is needed).
 */
export function coverageOf(
  westDeg: number,
  southDeg: number,
  eastDeg: number,
  northDeg: number,
): TileRectangleRad | undefined {
  const finite = [westDeg, southDeg, eastDeg, northDeg].every(Number.isFinite);
  if (!finite || westDeg >= eastDeg || southDeg >= northDeg) return undefined;
  if (westDeg <= -180 && eastDeg >= 180 && southDeg <= -85 && northDeg >= 85) return undefined;
  return { westRad: westDeg * DEG, southRad: southDeg * DEG, eastRad: eastDeg * DEG, northRad: northDeg * DEG };
}

/** True when a tile lies within the source's levels and overlaps its coverage. */
export function inLevelsAndCoverage(
  source: Pick<ImagerySource, 'minLevel' | 'maxLevel' | 'coverage' | 'tiling'>,
  coord: TileCoord,
  scratch: TileRectangleRad,
): boolean {
  if (coord.level < source.minLevel || coord.level > source.maxLevel) return false;
  return !source.coverage || inCoverage(source.coverage, source.tiling.tileExtent(coord, scratch));
}
