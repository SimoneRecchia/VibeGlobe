// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { GltfBufferView } from './document.js';
import { ModelError } from './errors.js';

/** The decoder this package calls: meshoptimizer's (MIT) WebAssembly behind {@link meshoptWasmDecoder}, or a stand-in. */
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

/** The exports of meshoptimizer's decoder module (`meshopt-decoder.wasm`): its C interface, and `sbrk` for memory. */
interface MeshoptExports {
  readonly memory: WebAssembly.Memory;
  __wasm_call_ctors(): void;
  sbrk(bytes: number): number;
  [decoder: string]: unknown;
}

type DecodeFunction = (target: number, count: number, size: number, source: number, sourceBytes: number) => number;
type FilterFunction = (buffer: number, count: number, stride: number) => void;

/** The C functions of each glTF mode (`EXT_meshopt_compression`) and filter. */
const DECODERS: Readonly<Record<string, string>> = {
  ATTRIBUTES: 'meshopt_decodeVertexBuffer',
  TRIANGLES: 'meshopt_decodeIndexBuffer',
  INDICES: 'meshopt_decodeIndexSequence',
};
const FILTERS: Readonly<Record<string, string | undefined>> = {
  NONE: undefined,
  OCTAHEDRAL: 'meshopt_decodeFilterOct',
  QUATERNION: 'meshopt_decodeFilterQuat',
  EXPONENTIAL: 'meshopt_decodeFilterExp',
  COLOR: 'meshopt_decodeFilterColor',
};

/**
 * A decoder over meshoptimizer's WebAssembly module, compiled by `compile` on first use: meshoptimizer's own
 * JavaScript starts workers from Blob URLs, which a strict Content Security Policy refuses (F100, ADR 0020), so the
 * engine ships the module alone (`@vibeglobe/worker`'s `wasm/meshopt-decoder.wasm`) and calls its C interface here.
 */
export function meshoptWasmDecoder(compile: () => Promise<WebAssembly.Module>): MeshoptLoader {
  let decoder: Promise<MeshoptDecoderLike> | undefined;
  return () =>
    (decoder ??= compile().then(async (module) => {
      const exports = (await WebAssembly.instantiate(module, {})).exports as unknown as MeshoptExports;
      exports.__wasm_call_ctors();
      return { supported: true, ready: Promise.resolve(), decodeGltfBuffer: decodeWith(exports) };
    }));
}

/** `decodeGltfBuffer` over the module: the stream and the result in the module's memory, freed after each call. */
function decodeWith(wasm: MeshoptExports): MeshoptDecoderLike['decodeGltfBuffer'] {
  return (target, count, size, source, mode, filter = 'NONE') => {
    const decode = wasm[DECODERS[mode] ?? ''] as DecodeFunction | undefined;
    if (!decode) throw new Error(`unknown meshopt mode ${mode}`);
    if (!(filter in FILTERS)) throw new Error(`unknown meshopt filter ${filter}`);
    const filterName = FILTERS[filter];
    // Filters run on groups of four elements: room for the last group.
    const padded = (count + 3) & ~3;
    const output = wasm.sbrk(padded * size);
    const input = wasm.sbrk(source.length);
    try {
      new Uint8Array(wasm.memory.buffer).set(source, input);
      const status = decode(output, count, size, input, source.length);
      if (status !== 0) throw new Error(`meshopt ${mode} stream did not decode (${status})`);
      if (filterName !== undefined) (wasm[filterName] as FilterFunction)(output, padded, size);
      target.set(new Uint8Array(wasm.memory.buffer, output, count * size));
    } finally {
      wasm.sbrk(output - wasm.sbrk(0));
    }
  };
}

/**
 * The default loader: none, so a meshopt model fails with a clear message instead of loading a decoder from an unknown
 * place. The engine's worker program passes {@link meshoptWasmDecoder} with the module it ships; tests and tools pass
 * their own loader.
 */
export const loadMeshoptDecoder: MeshoptLoader = () =>
  Promise.reject(new Error('meshopt decoding needs a decoder: pass `meshopt: meshoptWasmDecoder(...)`'));

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
