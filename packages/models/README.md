# @vibeglobe/models

glTF 2.0 and GLB parsing and validation for VibeGlobe, Draco and meshopt decoding, node transforms, and a
renderer-neutral `ModelDescription` (flat typed arrays, materials as numbers, encoded images). It has no DOM and no
three.js. The engine's worker program uses it to parse the glTF content of 3D Tiles. An application imports it to
decode meshopt models for three.js's `GLTFLoader` (`meshoptWasmDecoder`), to parse 3D Tiles content without the worker
program (`createModelTasks`), or to check a glTF file itself (`parseModel`). `ModelLayer` and `ModelSetLayer` of
`@vibeglobe/layers/models` load models through the renderer's `gltf` loader instead.

## Install

`@vibeglobe/core` and `draco3d` install with it; there are no peer dependencies. Decoders are files the application
hosts: meshoptimizer's module ships in `@vibeglobe/worker` as `wasm/meshopt-decoder.wasm`, and `loadDraco3d(wasmUrl)`
loads `draco_decoder.wasm` from your URL.

## Entry points

| Import              | What                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `@vibeglobe/models` | `parseModel`, `validateGltf`, `createModelLoader`, `createModelTasks`, `meshoptWasmDecoder` |

## Example

```ts
import { meshoptWasmDecoder, ModelError, parseModel } from '@vibeglobe/models';

declare const file: File;

const meshopt = meshoptWasmDecoder(() => WebAssembly.compileStreaming(fetch('/vibeglobe/meshopt-decoder.wasm')));
try {
  const model = await parseModel(new Uint8Array(await file.arrayBuffer()), { meshopt });
  console.log(`${model.stats.triangles} triangles in ${model.meshes.length} meshes`);
} catch (error) {
  if (!(error instanceof ModelError)) throw error;
  console.warn(error.code, error.message);
}
```

## Errors

Every failure is a `ModelError` whose `code` is one of `'invalid-glb'`, `'invalid-json'`, `'invalid-gltf'`,
`'unsupported'` (an extension or feature not read), `'missing-resource'`, `'decode-failed'` or `'too-large'`.

## Pitfalls

- A meshopt model needs a `meshopt` loader: the default rejects, and the parse fails with `'decode-failed'`.
- A Draco model without a `draco` loader fails with `'unsupported'`.
- A `.gltf` with external buffers or images needs them in `resources` (`externalUris` lists them);
  `createModelLoader` fetches them itself.
- Declared buffers above `limits.maxBytes` (default 256 MiB) fail with `'too-large'`.

## Guides

- [3D models](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/models.md)
