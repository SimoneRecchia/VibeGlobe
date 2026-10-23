import { buildModel } from './build.js';
import type { ModelDescription } from './description.js';
import type { GltfDocument } from './document.js';
import type { DracoLoader } from './draco.js';
import { ModelError } from './errors.js';
import { isGlb, parseGlb } from './glb.js';
import { loadMeshoptDecoder, type MeshoptLoader } from './meshopt.js';
import { needsMeshopt, resolveBuffers, resolveImages, resolveViews, type ModelResources } from './resources.js';
import { validateGltf } from './validate.js';

/** Size limits that keep a hostile or broken file from exhausting memory. */
export interface ModelLimits {
  /** Largest sum of declared buffer lengths and decoded meshopt views, in bytes (default 256 MiB). */
  readonly maxBytes?: number;
}

/** Options of {@link parseModel}. */
export interface ParseModelOptions {
  /** External buffers and images of a `.gltf`, by the URI the document writes ({@link externalUris} lists them). */
  readonly resources?: ModelResources;
  /** Loads the Draco decoder; without it a Draco-compressed model is rejected ('unsupported'). */
  readonly draco?: DracoLoader;
  /** Loads the meshopt decoder (default: meshoptimizer's module, loaded only for models that need it). */
  readonly meshopt?: MeshoptLoader;
  readonly limits?: ModelLimits;
}

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

/**
 * Reads the JSON document of a model: from a GLB container, or from the bytes of a `.gltf` file. Returns the
 * validated document and the GLB's BIN chunk. Throws a ModelError for a broken container or document.
 */
export function readDocument(bytes: Uint8Array): { doc: GltfDocument; bin: Uint8Array | undefined } {
  let text: string;
  let bin: Uint8Array | undefined;
  if (isGlb(bytes)) ({ json: text, bin } = parseGlb(bytes));
  else text = new TextDecoder().decode(bytes);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw new ModelError('invalid-json', 'the glTF JSON does not parse', { cause });
  }
  return { doc: validateGltf(json), bin };
}

function checkLimits(doc: GltfDocument, limits: ModelLimits | undefined): void {
  const maxBytes = limits?.maxBytes ?? DEFAULT_MAX_BYTES;
  let total = 0;
  for (const buffer of doc.buffers) total += buffer.byteLength;
  for (const view of doc.bufferViews) if (view.meshopt) total += view.meshopt.count * view.meshopt.byteStride;
  for (const accessor of doc.accessors) total += accessor.count * 16;
  if (total > maxBytes) throw new ModelError('too-large', `the model declares ${total} bytes, more than ${maxBytes}`);
}

/**
 * Parses, validates and decodes a glTF 2.0 model (`.glb` bytes, or `.gltf` bytes with `resources`) into the
 * renderer-neutral {@link ModelDescription} (F361). Draco and meshopt decoders load lazily, only for models that
 * need them. Rejects with a ModelError for every truncated, corrupt or unsupported input; never with anything else.
 */
export async function parseModel(bytes: Uint8Array, options: ParseModelOptions = {}): Promise<ModelDescription> {
  try {
    const { doc, bin } = readDocument(bytes);
    checkLimits(doc, options.limits);
    const buffers = resolveBuffers(doc, bin, options.resources ?? {});
    const meshopt = needsMeshopt(doc) ? await (options.meshopt ?? loadMeshoptDecoder)() : undefined;
    const views = resolveViews(doc, buffers, meshopt);
    const usesDraco = doc.meshes.some((mesh) => mesh.primitives.some((p) => p.draco !== undefined));
    const draco = usesDraco && options.draco ? await options.draco() : undefined;
    const images = resolveImages(doc, views, options.resources ?? {});
    return buildModel({ doc, views, draco }, images);
  } catch (error) {
    if (error instanceof ModelError) throw error;
    // Anything else (a decoder's own exception, an out-of-memory RangeError) still reaches callers as a model error.
    throw new ModelError('decode-failed', error instanceof Error ? error.message : String(error), { cause: error });
  }
}
