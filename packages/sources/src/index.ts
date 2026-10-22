/**
 * @packageDocumentation
 * Source adapters for imagery, terrain, vector and 3D data, with provider profiles.
 * @module @vibeglobe/sources
 */
export { fetchTransport, retryAfterMs } from './fetch-transport.js';
export { xyzImagery } from './xyz-imagery.js';
export type { XyzImageryOptions } from './xyz-imagery.js';
export { CUSTOM_PROFILE, SourceConfigError } from './metadata.js';
export type { Attribution, DescribedImagerySource, LoadingSwitches, ProviderProfile } from './metadata.js';
export { pmtilesImagery } from './pmtiles-imagery.js';
export type { PmtilesImageryOptions } from './pmtiles-imagery.js';
export { mbtilesImagery } from './mbtiles-imagery.js';
export type { MbtilesImageryOptions } from './mbtiles-imagery.js';
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
