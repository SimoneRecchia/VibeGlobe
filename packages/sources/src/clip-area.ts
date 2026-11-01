// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import {
  type CoverageArea,
  type CoverageTest,
  type GeoJsonArea,
  type ImagerySource,
  type TileCoord,
  type TileRectangleRad,
  type TilingScheme,
} from '@vibeglobe/core';
import { coverageArea, coverageTest } from '@vibeglobe/core/coverage';

/** A source's `area` option, prepared: its tile test and, when clipped per pixel, its tile masks (F618). */
export interface SourceArea {
  readonly test: CoverageTest;
  /** True when border tiles are clipped or keyed per pixel: the source is then transparent. */
  readonly clip: boolean;
  /** The decoder's mask of a tile (`ImagerySource.tileMask`), for a clipped area. */
  readonly tileMask?: ImagerySource['tileMask'];
}

/**
 * Prepares an `area` option (an area or GeoJSON) for a source cut in `tiling` with tiles of `tileSizePx`; undefined
 * without one.
 */
export function sourceArea(
  input: CoverageArea | GeoJsonArea | undefined,
  tiling: TilingScheme,
  tileSizePx = 256,
): SourceArea | undefined {
  if (!input) return undefined;
  const area = coverageArea(input);
  const test = coverageTest(area);
  // The sea's key masks per pixel too: without it the sea of a source keying it alone stayed (KB-329).
  if (area.tiles !== 'clip' && !area.keyOutside && !area.keyEverywhere && !area.keySea) return { test, clip: false };
  const extent: TileRectangleRad = { westRad: 0, southRad: 0, eastRad: 0, northRad: 0 };
  const mercator = tiling.crs === 'EPSG:3857';
  return {
    test,
    clip: true,
    tileMask: (coord: TileCoord) => test.mask(tiling.tileExtent(coord, extent), mercator, tileSizePx),
  };
}
