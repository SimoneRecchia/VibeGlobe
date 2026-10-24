/**
 * Tile decoders that run in the engine's workers (`@vibeglobe/core/decoders`: heightmaps, quantized-mesh and KTX2),
 * the height grids of custom terrain decoders, the geoid file format and the quantized-mesh `layer.json` reader: kept
 * out of the main entry so that applications load them only with the worker program or the adapters that need them.
 * @packageDocumentation
 */
export {
  decodeQuantizedMesh,
  EXTENSION_METADATA,
  EXTENSION_OCT_NORMALS,
  EXTENSION_WATER_MASK,
  meshGridErrorMeters,
  rasterizeQuantizedMesh,
} from './terrain/quantized-mesh.js';
export type { QuantizedMesh } from './terrain/quantized-mesh.js';
export {
  chooseKtx2Target,
  isKtx2,
  Ktx2Error,
  KTX2_TARGET_CODES,
  ktx2GpuBytes,
  ktx2LevelBytes,
  ktx2LevelRange,
  ktx2LevelSize,
  readKtx2,
} from './imagery/ktx2.js';
export { readLayerJson, readRanges, TerrainAvailability } from './terrain/layer-json.js';
export type { TerrainLayer, TileRange } from './terrain/layer-json.js';
export { decodeHeightmap, heightGrid } from './terrain/heightmap.js';
export type { HeightGrid, HeightmapEncoding } from './terrain/heightmap.js';
export { chooseGrid, gridErrorMeters, GRID_CELLS } from './terrain/grid-size.js';
export type { MeasuredGrid } from './terrain/grid-size.js';
export { readGeoidFile, writeGeoidFile } from './terrain/geoid-file.js';
