// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * `@vibeglobe/presets/countries`: the borders of Europe's countries for sources limited to one country, such as a
 * national orthophoto service that answers with white tiles outside its country (F618, KB-209). Each country's borders
 * load on demand, so an application carries only those it uses.
 *
 * @packageDocumentation
 */
import type { GeoJsonArea } from '@vibeglobe/core';
import { COUNTRY_BORDERS } from './countries/index.js';

/** The ISO 3166-1 alpha-2 codes with borders. */
export const COUNTRY_CODES: readonly string[] = Object.keys(COUNTRY_BORDERS);

/**
 * A country's borders as a GeoJSON MultiPolygon, the `area` of a source clipped to it: Natural Earth 1:10m (public
 * domain), simplified to about 300 m. Throws a `RangeError` for a code without borders.
 *
 * @example
 * const austria = xyzImagery({ id: 'basemap-at', url, area: await countryBorders('AT') });
 */
export async function countryBorders(code: string): Promise<GeoJsonArea> {
  const load = COUNTRY_BORDERS[code.toUpperCase()];
  if (!load) throw new RangeError(`No borders for the country code "${code}" (known: ${COUNTRY_CODES.join(', ')})`);
  const polygons = (await load()).default;
  return {
    type: 'MultiPolygon',
    coordinates: polygons.map((polygon) => polygon.map((ring) => ring.map((p) => [...p]))),
  };
}
