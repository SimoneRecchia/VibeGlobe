/**
 * Tile decoders that run in the engine's workers (`@vibeglobe/core/decoders`, quantized-mesh and KTX2): kept out of the main entry so that
 * applications load them only with the worker program.
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
