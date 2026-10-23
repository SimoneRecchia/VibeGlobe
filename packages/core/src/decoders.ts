/**
 * Tile decoders that run in the engine's workers (`@vibeglobe/core/decoders`): kept out of the main entry so that
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
