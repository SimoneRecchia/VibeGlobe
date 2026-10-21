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
export { Camera } from './camera/camera.js';
export type { CameraPose } from './camera/camera.js';
export {
  DEFAULT_FOV_Y_RAD,
  groundMetersPerPixel,
  groundZoomForRange,
  groundZoomFromMercatorZoom,
  mercatorZoomFromGroundZoom,
  rangeForGroundZoom,
} from './camera/zoom.js';
export { createGlobe } from './globe/create-globe.js';
export { GlobeError } from './globe/errors.js';
export type { GlobeErrorCode } from './globe/errors.js';
export type {
  BackendName,
  DepthPath,
  CameraState,
  Controls,
  DebugMeshData,
  DebugShape,
  ControlsFactory,
  FrameView,
  GeoPosition,
  Globe,
  GlobeEvents,
  GlobeOptions,
  NavigationApi,
  RendererBackend,
  RendererCapabilities,
  RendererEvents,
  RendererFactory,
  RendererStats,
  RenderHost,
  ResourceCounts,
  ScreenPoint,
  ViewInit,
} from './globe/types.js';
export { buildTileMesh } from './surface/surface-mesh.js';
export { IntegerKeyMap } from './collections/integer-key-map.hot.js';
export type { TileMeshData } from './surface/surface-mesh.js';
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
export { geodesicInverse } from './geodesy/geodesic-inverse.js';
export type { GeodesicInverseResult } from './geodesy/geodesic-inverse.js';
export { geodesicDirect } from './geodesy/geodesic-direct.js';
export type { GeodesicDirectResult } from './geodesy/geodesic-direct.js';
export { geodesicPathLengthMeters, geodesicPolygonArea } from './geodesy/geodesic-polygon.js';
export type { GeodesicPoint, GeodesicPolygonArea } from './geodesy/geodesic-polygon.js';
