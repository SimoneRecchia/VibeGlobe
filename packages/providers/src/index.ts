// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * @packageDocumentation
 * Ready services for particular providers (ADR 0186): MapTiler's maps and terrain, Esri's basemaps, OpenFreeMap's
 * vector maps, Photon's place search and OpenStreetMap's tiles. Optional: an application may write its own
 * `TileService`, terrain source and `GeocoderService` for any other provider; it holds the keys and keeps the terms.
 * @module @vibeglobe/providers
 */
export { esriTiles } from './esri.js';
export { mapTilerTerrain, mapTilerTiles } from './maptiler.js';
export { openFreeMapTiles } from './openfreemap.js';
export { photonGeocoder } from './photon.js';
export {
  OSM_ODBL_ATTRIBUTION,
  OSM_PUBLIC_MAX_CONCURRENT,
  OSM_PUBLIC_PROFILE,
  OSM_SELF_HOSTED_PROFILE,
  openStreetMapHostedImagery,
  openStreetMapImagery,
} from './openstreetmap.js';
export type { OpenStreetMapHostedOptions, OpenStreetMapImageryOptions } from './openstreetmap.js';
