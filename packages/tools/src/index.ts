/**
 * @packageDocumentation
 * Command-line tools: the dataset pipeline and the offline package builder (`vibeglobe-data`), also usable as a
 * library from Node.
 * @module @vibeglobe/tools
 */
export { main, type CliIo } from './cli.js';
export { configProblems, loadConfig, type LoadedConfig } from './config/load.js';
export type {
  AreaConfig,
  BuildConfig,
  CopernicusDemSource,
  DatasetConfig,
  GeoTiffSource,
  OsmExtractSource,
  OutputsConfig,
  PricesConfig,
  S2CloudlessSource,
  SampleAreaConfig,
  SourceConfig,
  ToolsConfig,
  XyzSource,
} from './config/schema.js';
export { type BuildEstimate, type DatasetEstimate, type ZoomEstimate, formatEstimate } from './estimate.js';
export { type LicenseViolation, checkDatasets, checkSource } from './license/gate.js';
export { PROVIDER_PROFILES, type ProviderProfile, findProfile } from './license/profiles.js';
export { type OutputMetadata } from './output/metadata.js';
export { readMbtiles, writeMbtiles } from './output/mbtiles.js';
export { PmtilesReader, writePmtiles } from './output/pmtiles.js';
export { type PackEstimate, type PackRequest, estimatePack, fetchPackTiles, gatePack, writePack } from './pack/pack.js';
export { type BuildOptions, type BuildResult, estimateBuild, runBuild } from './pipeline/build.js';
export { type TerrainCheck, verifyTerrain } from './pipeline/verify-terrain.js';
export { PIPELINE_VERSION } from './version.js';
