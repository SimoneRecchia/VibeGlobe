/**
 * Writes `packages/worker/wasm/meshopt-decoder.wasm`: the WebAssembly decoder that meshoptimizer (MIT) embeds in its
 * `meshoptimizer/decoder` module, without that module's JavaScript, which starts workers from Blob URLs that a strict
 * Content Security Policy refuses (F100, ADR 0020). The portable build without SIMD is taken. Run with
 * `node scripts/extract-meshopt-wasm.ts` after updating meshoptimizer, then `npm run notices`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ROOT_DIR } from './workspace.ts';

const captured: Uint8Array[] = [];
const instantiate = WebAssembly.instantiate.bind(WebAssembly);
// The module picks its SIMD build when WebAssembly.validate accepts a SIMD probe: refused, it takes the portable one.
WebAssembly.validate = () => false;
WebAssembly.instantiate = ((bytes: BufferSource, imports?: WebAssembly.Imports) => {
  captured.push(new Uint8Array(bytes as ArrayBuffer));
  return instantiate(bytes, imports);
}) as typeof WebAssembly.instantiate;
const { MeshoptDecoder } = (await import('meshoptimizer/decoder')) as { MeshoptDecoder: { ready: Promise<void> } };
await MeshoptDecoder.ready;
const wasm = captured[0];
if (wasm === undefined) throw new Error('meshoptimizer/decoder instantiated no WebAssembly module');
const directory = join(ROOT_DIR, 'packages/worker/wasm');
writeFileSync(join(directory, 'meshopt-decoder.wasm'), wasm);
const packageDir = join(createRequire(import.meta.url).resolve('meshoptimizer/decoder'), '..');
writeFileSync(join(directory, 'licenses/meshoptimizer.txt'), readFileSync(join(packageDir, 'LICENSE.md')));
const { version } = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { version: string };
console.log(`meshopt-decoder.wasm: ${wasm.length} bytes from meshoptimizer ${version}`);
