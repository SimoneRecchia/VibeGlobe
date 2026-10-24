// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Geodesics on the WGS84 ellipsoid (`@vibeglobe/core/geodesy`): inverse and direct problems, path lengths and polygon
 * areas. The engine itself never needs them, so they stay out of the main entry and load only with the measurement,
 * drawing and minimap code that uses them.
 * @packageDocumentation
 */
export { geodesicInverse } from './geodesy/geodesic-inverse.js';
export type { GeodesicInverseResult } from './geodesy/geodesic-inverse.js';
export { geodesicDirect } from './geodesy/geodesic-direct.js';
export type { GeodesicDirectResult } from './geodesy/geodesic-direct.js';
export { geodesicPathLengthMeters, geodesicPolygonArea } from './geodesy/geodesic-polygon.js';
export type { GeodesicPoint, GeodesicPolygonArea } from './geodesy/geodesic-polygon.js';
