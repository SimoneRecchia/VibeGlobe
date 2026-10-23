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
export { combineProfiles, CUSTOM_PROFILE, SourceConfigError, withProfile } from './metadata.js';
export type {
  Attribution,
  DescribedImagerySource,
  DescribedSource,
  LoadingSwitches,
  ProviderProfile,
} from './metadata.js';
export { imageSizeOf, parseWorldFile, singleImage } from './single-image.js';
export type { SingleImageOptions, WorldFile } from './single-image.js';
export { pmtilesArchive, pmtilesImagery, pmtilesTerrain, pmtilesVector } from './pmtiles-imagery.js';
export type { ArchiveContent } from './pmtiles-imagery.js';
export type { ArchiveTerrainEncoding, ArchiveTerrainOptions, VectorTileSource } from './archive-sources.js';
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
export { followGoogleCopyrights, googleImagery, googleProfile } from './providers/google-provider.js';
export type {
  GoogleBillingRegion,
  GoogleImageryOptions,
  GoogleImagerySource,
  GoogleProfile,
  GoogleSourceOptions,
  CopyrightGlobe,
  GoogleViewport,
} from './providers/google-provider.js';
export { googleStreetView } from './providers/google-street-view-provider.js';
export type { GoogleStreetView, StreetViewMetadata, StreetViewQuery } from './providers/google-street-view-provider.js';
export {
  OSM_ODBL_ATTRIBUTION,
  OSM_PUBLIC_MAX_CONCURRENT,
  OSM_PUBLIC_PROFILE,
  OSM_SELF_HOSTED_PROFILE,
  openStreetMapHostedImagery,
  openStreetMapImagery,
} from './providers/openstreetmap-provider.js';
export type { OpenStreetMapHostedOptions, OpenStreetMapImageryOptions } from './providers/openstreetmap-provider.js';
export { composeInBrowser, reprojectedImagery, warpInBrowser } from './reproject/reprojected-imagery.js';
export type {
  ComposeImage,
  FetchedPart,
  ImagePart,
  ReprojectedImageryOptions,
  WarpImage,
} from './reproject/reprojected-imagery.js';
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
