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
