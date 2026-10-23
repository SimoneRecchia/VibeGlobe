import type { GltfBufferView } from './document.js';
import { ModelError } from './errors.js';

/** The part of meshoptimizer's decoder (`meshoptimizer/decoder`, MIT) this package calls. */
export interface MeshoptDecoderLike {
  readonly supported: boolean;
  readonly ready: Promise<void>;
  decodeGltfBuffer(
    target: Uint8Array,
    count: number,
    size: number,
    source: Uint8Array,
    mode: string,
    filter?: string,
  ): void;
}

/** Loads the meshopt decoder, lazily, on the first model that needs it. */
export type MeshoptLoader = () => Promise<MeshoptDecoderLike>;

/** The default loader: meshoptimizer's ES module decoder (its WebAssembly is embedded, so it needs no URL). */
export const loadMeshoptDecoder: MeshoptLoader = async () => {
  const { MeshoptDecoder } = await import('meshoptimizer/decoder');
  await MeshoptDecoder.ready;
  return MeshoptDecoder;
};

/**
 * Decodes a meshopt-compressed buffer view (`EXT_meshopt_compression`/`KHR_meshopt_compression`) into a new array of
 * `count × byteStride` bytes, from its compressed range in `source` (the bytes of the extension's buffer). A stream
 * that does not decode to exactly the declared size throws a ModelError ('decode-failed').
 */
export function decodeMeshoptView(
  decoder: MeshoptDecoderLike,
  view: GltfBufferView,
  source: Uint8Array,
  index: number,
): Uint8Array {
  const meshopt = view.meshopt;
  if (!meshopt) throw new ModelError('invalid-gltf', `bufferViews[${index}] is not meshopt-compressed`);
  if (meshopt.byteOffset + meshopt.byteLength > source.byteLength)
    throw new ModelError('invalid-gltf', `bufferViews[${index}]: compressed range runs past its buffer`);
  const target = new Uint8Array(meshopt.count * meshopt.byteStride);
  const compressed = source.subarray(meshopt.byteOffset, meshopt.byteOffset + meshopt.byteLength);
  try {
    decoder.decodeGltfBuffer(target, meshopt.count, meshopt.byteStride, compressed, meshopt.mode, meshopt.filter);
  } catch (cause) {
    throw new ModelError('decode-failed', `bufferViews[${index}]: meshopt stream did not decode`, { cause });
  }
  return target;
}
