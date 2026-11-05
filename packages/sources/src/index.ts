// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * @packageDocumentation
 * Generic source adapters for imagery, terrain, vector and 3D data (XYZ, WMTS, WMS, PMTiles, MBTiles, …) and the
 * provider profiles any provider's terms are declared with; no adapter of a particular provider (ADR 0186).
 * @module @vibeglobe/sources
 */
export { fetchTransport, maxAgeOf, redactUrl, retryAfterMs } from './fetch-transport.js';
export { expectTiming, takeTiming } from './resource-timing.js';
export type { NetworkTiming } from './resource-timing.js';
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
export { mercatorImage } from './mercator-image.js';
export type { CutTile, MercatorImageOptions } from './mercator-image.js';
export {
  DAY_IMAGE_CREDIT,
  DAY_IMAGE_POLAR_CAPS,
  dayImageUrl,
  NIGHT_LIGHTS_ID,
  nightImageUrl,
  nightLights,
} from './earth-images.js';
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
