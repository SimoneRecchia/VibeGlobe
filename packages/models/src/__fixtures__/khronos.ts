import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { externalUris, meshoptWasmDecoder, readDocument, type ModelResources } from '../index.js';

const ROOT = fileURLToPath(new URL('./khronos/', import.meta.url));

/** The meshopt decoder the engine's worker program ships, compiled from its file. */
export const meshopt = meshoptWasmDecoder(() =>
  WebAssembly.compile(readFileSync(new URL('../../../worker/wasm/meshopt-decoder.wasm', import.meta.url))),
);

/** A Khronos sample model variant from `khronos/` (see its README for licenses): the file and its external files. */
export interface SampleFile {
  readonly bytes: Uint8Array;
  readonly resources: ModelResources;
}

/** Reads `khronos/<model>/<variant>/`'s `.glb` or `.gltf` and every external file its document names. */
export function sample(model: string, variant: string): SampleFile {
  const dir = join(ROOT, model, variant);
  const file = readdirSync(dir).find((name) => name.endsWith('.glb') || name.endsWith('.gltf'));
  if (!file) throw new Error(`no model in ${dir}`);
  const bytes = new Uint8Array(readFileSync(join(dir, file)));
  const resources: Record<string, Uint8Array> = {};
  if (file.endsWith('.gltf'))
    for (const uri of externalUris(readDocument(bytes).doc))
      resources[uri] = new Uint8Array(readFileSync(join(dir, decodeURIComponent(uri))));
  return { bytes, resources };
}

/** Every model and variant in `khronos/`. */
export function allSamples(): { model: string; variant: string }[] {
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => readdirSync(join(ROOT, entry.name)).map((variant) => ({ model: entry.name, variant })));
}
