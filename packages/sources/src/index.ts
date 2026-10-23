/**
 * @packageDocumentation
 * Source adapters for imagery, terrain, vector and 3D data, with provider profiles.
 * @module @vibeglobe/sources
 */
export { fetchTransport, redactUrl, retryAfterMs } from './fetch-transport.js';
export type { FetchTransportExtras, SourceAuth } from './fetch-transport.js';
export { xyzImagery } from './xyz-imagery.js';
export type { XyzImageryOptions } from './xyz-imagery.js';
export { heightmapTerrain } from './heightmap-terrain.js';
export type { HeightmapTerrainOptions } from './heightmap-terrain.js';
export { quantizedMeshTerrain } from './quantized-mesh-terrain.js';
export type { QuantizedMeshTerrainOptions } from './quantized-mesh-terrain.js';
export { CUSTOM_PROFILE, SourceConfigError } from './metadata.js';
export type { Attribution, DescribedImagerySource, LoadingSwitches, ProviderProfile } from './metadata.js';
export { pmtilesImagery } from './pmtiles-imagery.js';
export type { PmtilesImageryOptions } from './pmtiles-imagery.js';
export { wmtsImagery } from './ogc/wmts-imagery.js';
export type { WmtsImageryOptions } from './ogc/wmts-imagery.js';
export { parseWmtsCapabilities } from './ogc/wmts-capabilities.js';
export type {
  WmtsCapabilities,
  WmtsLayer,
  WmtsLimits,
  WmtsTileMatrix,
  WmtsTileMatrixSet,
} from './ogc/wmts-capabilities.js';
export { wmsImagery } from './ogc/wms-imagery.js';
export type { WmsImageryOptions } from './ogc/wms-imagery.js';
export { parseWmsCapabilities } from './ogc/wms-capabilities.js';
export type { WmsCapabilities, WmsLayer } from './ogc/wms-capabilities.js';
export type { CropImage } from './ogc/wms-transport.js';
export { googleImagery, googleProfile } from './providers/google-provider.js';
export type {
  GoogleBillingRegion,
  GoogleImageryOptions,
  GoogleImagerySource,
  GoogleProfile,
  GoogleSourceOptions,
  GoogleViewport,
} from './providers/google-provider.js';
export { googleStreetView } from './providers/google-street-view-provider.js';
export type { GoogleStreetView, StreetViewMetadata, StreetViewQuery } from './providers/google-street-view-provider.js';
export {
  OSM_PUBLIC_MAX_CONCURRENT,
  OSM_PUBLIC_PROFILE,
  openStreetMapImagery,
} from './providers/openstreetmap-provider.js';
export type { OpenStreetMapImageryOptions } from './providers/openstreetmap-provider.js';
export { reprojectedImagery, warpInBrowser } from './reproject/reprojected-imagery.js';
export type { ReprojectedImageryOptions, WarpImage } from './reproject/reprojected-imagery.js';
export { wmsGetMapUrl } from './reproject/wms-get-map.js';
export type { WmsGetMapParameters } from './reproject/wms-get-map.js';
export { lonLatBoundsOf, planWarp, solveAffine } from './reproject/warp-math.js';
export type {
  Affine,
  FromSource,
  SourceBbox,
  ToSource,
  Triangle,
  WarpPlan,
  WarpTriangle,
} from './reproject/warp-math.js';
