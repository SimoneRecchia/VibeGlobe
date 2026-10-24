// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * @packageDocumentation
 * GIS utilities: coordinate parsing and formatting, reference-system transforms, geodesic measurement and view-state
 * serialization. Pure functions, usable without the engine's renderer or the ui package.
 * @module @vibeglobe/gis
 */
export { crsCodes, defineCrs, transformCoordinates } from './crs.js';
export type { CrsPoint } from './crs.js';
export { formatCoordinate } from './format.js';
export type { CoordinateFormat, CoordinateFormatOptions, LonLat } from './format.js';
export { parseCoordinate, parseCoordinateResult } from './parse.js';
export type { CoordinateParseError, CoordinateParseErrorCode, CoordinateParseResult } from './parse.js';
export { fromUtm, toUtm, utmBand, utmZone } from './utm.js';
export type { UtmCoordinate } from './utm.js';
export { formatArea, formatLength, measureArea, measureDistance, measurePathLength } from './measure.js';
export type { GeodesicMeasurement } from './measure.js';
export {
  normalizeViewState,
  viewStateOf,
  VIEW_URL_PARAMETER,
  viewStateFromFragment,
  viewStateFromJson,
  viewStateFromUrl,
  viewStateToFragment,
  viewStateToJson,
  viewStateToUrl,
} from './view-state.js';
export type { ViewMode, ViewState } from './view-state.js';
