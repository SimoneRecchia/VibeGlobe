/**
 * @packageDocumentation
 * Framework-agnostic core of VibeGlobe: math, WGS84 geodesy, camera, tiling, scheduling, cache and events.
 * @module @vibeglobe/core
 */
export { FrameStats } from './diagnostics/frame-stats.js';
export { WGS84 } from './geodesy/wgs84.js';
export type { Ellipsoid } from './geodesy/wgs84.js';
export { ecefToGeodetic, geodeticToEcef } from './geodesy/ecef.js';
export type { GeodeticRad } from './geodesy/ecef.js';
export {
  enuFrame,
  enuFrameDeg,
  headingPitchRollToRotationDeg,
  headingPitchRollToRotationRad,
  rotationToHeadingPitchRollDeg,
  rotationToHeadingPitchRollRad,
} from './geodesy/enu.js';
export type { HeadingPitchRollDeg } from './geodesy/enu.js';
export {
  nearestWorldCopyXMeters,
  WORLD_WIDTH_METERS,
  wrapLongitudeDeg,
  wrapLongitudeRad,
} from './projections/longitude.js';
export {
  clampWebMercatorLatitudeRad,
  projectWebMercatorDeg,
  projectWebMercatorRad,
  unprojectWebMercatorDeg,
  unprojectWebMercatorRad,
  WEB_MERCATOR_HALF_EXTENT_METERS,
  WEB_MERCATOR_MAX_LATITUDE_DEG,
  WEB_MERCATOR_MAX_LATITUDE_RAD,
  webMercatorScaleFactor,
  webMercatorXNearestRad,
} from './projections/web-mercator.js';
export {
  GEOGRAPHIC_HALF_HEIGHT_METERS,
  projectGeographicDeg,
  projectGeographicRad,
  unprojectGeographicDeg,
  unprojectGeographicRad,
} from './projections/geographic.js';
export type { LonLatDeg, ProjectedPointMeters } from './projections/types.js';
