// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Source areas as polygons (`@vibeglobe/core/coverage`, F618): the tile tests and per-pixel masks a source adapter
 * builds from a country's borders. The engine draws the masks the adapters give it and never needs these itself, so
 * they stay out of the main entry and load with the adapters that use them.
 * @packageDocumentation
 */
export { coverageArea, coverageTest } from './imagery/coverage-area.js';
export type {
  CoverageArea,
  CoverageTest,
  GeoJsonArea,
  KeyColor,
  PolygonDeg,
  RingDeg,
  TileMask,
} from './imagery/coverage-area.js';
