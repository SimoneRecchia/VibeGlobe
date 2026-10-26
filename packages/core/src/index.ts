// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * @packageDocumentation
 * Framework-agnostic core of VibeGlobe: math, WGS84 geodesy, camera, tiling, scheduling, cache and events.
 * @module @vibeglobe/core
 */
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
export { refuseDisplayOnlySource } from './globe/display-only.js';
export { surfaceVisibility } from './surface/fog.js';
export type { FogRay } from './surface/fog.js';
export { GlobeError } from './globe/errors.js';
export { refuseDisplayOnly } from './globe/display-only.js';
export type { GlobeErrorCode } from './globe/errors.js';
export type {
  AntialiasMode,
  AtmosphereLevel,
  AtmosphereSettings,
  QualitySettings,
  RendererQuality,
} from './globe/quality-types.js';
export type {
  BackendName,
  DepthPath,
  CameraState,
  Controls,
  DebugMeshData,
  DebugShape,
  ControlsFactory,
  FrameCapture,
  FrameView,
  TileDrawLayer,
  TileDrawList,
  GeoPosition,
  Globe,
  GlobeEvents,
  GlobeOptions,
  ImageryStats,
  TerrainStats,
  MemoryOptions,
  NavigationApi,
  RendererBackend,
  RendererCapabilities,
  RendererEvents,
  RendererFactory,
  RendererStats,
  RenderHost,
  ResourceCounts,
  ReloadOptions,
  ScreenPoint,
  SurfaceStats,
  SurfaceTileInfo,
  TileErrorEvent,
  TileErrorReason,
  ViewInit,
  CameraMovement,
  MoveCause,
  MoveEndEvent,
  MoveEvent,
  MoveOutcome,
  MovementOptions,
  GeoBounds,
  Geocoder,
  GeocoderResult,
  TourWaypoint,
  HomeView,
  CameraConstraints,
} from './globe/types.js';
export { NO_TERRAIN } from './globe/types.js';
export { MorphFrame, morphPointInto } from './view/morph.js';
export { AUTO_TILT_RANGE_DEG, DEFAULT_VIEW_CURVES, validateViewCurves } from './view/curves.js';
export type { GroundZoomRange, ViewCurves, ViewCurvesInit } from './view/curves.js';
export type { ViewMode, ViewPhase } from './view/view-state.js';
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
export { childTiles, MAX_TILE_LEVEL, packTileKey, parentTile, unpackTileKey } from './tiling/tile-key.js';
export type { TileCoord, TileKey } from './tiling/tile-key.js';
export { GEOGRAPHIC_TILING, WEB_MERCATOR_TILING } from './tiling/tiling-scheme.js';
export type { TileRectangleRad, TilingScheme } from './tiling/tiling-scheme.js';
export { inCoverage, LOAD_ALL, LOAD_KEEP_IN_MEMORY, LOAD_PREFETCH } from './imagery/imagery-source.js';
export { coverageArea, coverageTest } from './imagery/coverage-area.js';
export type {
  CoverageArea,
  CoverageTest,
  GeoJsonArea,
  PolygonDeg,
  RingDeg,
  TileMask,
} from './imagery/coverage-area.js';
export type { BlankTile, ImagerySource, TileSource } from './imagery/imagery-source.js';
export type { RenderExtension, RenderExtensionContext } from './globe/render-extensions.js';
export type { Attribution, Credit, CreditProfile } from './imagery/credits.js';
export type {
  ImageryBlend,
  ImageryLayerChanges,
  ImageryLayerInput,
  ImageryLayerOptions,
  ImageryLayers,
  ImageryLayerState,
  ImagerySourceInfo,
} from './imagery/imagery-stack.js';
export { sampleHeight } from './terrain/sample-height.js';
export { heightmapGeometricErrorMeters } from './terrain/terrain-source.js';
export type { TerrainDecoder, TerrainSource } from './terrain/terrain-source.js';
export type { ElevationSample } from './terrain/terrain-heights.js';
export type { AbortSignalLike } from './globe/imagery-runtime.js';
export { toEllipsoidal, undulationMeters } from './terrain/vertical-datum.js';
export type { GeoidModel, VerticalDatum } from './terrain/vertical-datum.js';
export { FRAME_PHASES } from './diagnostics/observability.js';
export type {
  FramePhase,
  GlobeDiagnostics,
  LogEntry,
  LogLevel,
  LogSink,
  PhaseTimesMs,
  TraceEvent,
} from './diagnostics/observability.js';
export type {
  CompressedLevel,
  CompressedTileImage,
  Ktx2ErrorCode,
  Ktx2Info,
  Ktx2Kind,
  Ktx2Target,
} from './imagery/ktx2.js';
export type {
  AbortHandle,
  DecodedTile,
  TileRequest,
  TileTransport,
  TimeoutsMs,
  TransportResult,
} from './scheduler/types.js';
export { serializeTaskError, WORKER_PROTOCOL_VERSION } from './scheduler/worker-protocol.js';
export { acquireWorkerPool } from './scheduler/worker-pool.js';
export type { NetworkPool, RequestConsumer } from './scheduler/network-pool.js';
export type {
  WorkerPool,
  WorkerPoolLease,
  WorkerPoolOptions,
  WorkerTaskOutcome,
  WorkerTaskRequest,
} from './scheduler/worker-pool-types.js';
export type {
  SerializedTaskError,
  TaskContext,
  TaskFunction,
  TaskOutput,
  TaskTable,
  WorkerCancelMessage,
  WorkerEndpoint,
  WorkerEndpointFactory,
  WorkerMessage,
  WorkerReadyMessage,
  WorkerReply,
  WorkerRequest,
  WorkerRunMessage,
} from './scheduler/worker-protocol.js';
export {
  ANCHORS,
  ATTRIBUTE_COMPONENTS,
  BATCH_ATTRIBUTES,
  type BatchAttribute,
  type BatchDescriptor,
  type BatchHandle,
  type BatchKind,
  type BatchStringChannel,
  type FeatureGeometry,
  type LayerGround,
  type LayerRenderTarget,
  type Placement,
} from './layers/layer-target.js';
export {
  layerOrigin,
  writeLayerVertex,
  writeLayerVertexAt,
  type LayerOrigin,
  type LayerVertices,
} from './layers/layer-geometry.js';
export type { ModelHandle, ModelOptions, ModelPose, ModelRenderer } from './layers/models.js';
