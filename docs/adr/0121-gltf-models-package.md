# 0121. glTF models: a renderer-neutral description decoded in workers

- Status: Accepted (decided by agent; owner may revisit)
- Date: 2026-10-23
- Milestone: M10

## Context

F361 asks for glTF 2.0 models (`.glb`, `.gltf` with external files, Draco geometry, KTX2 textures) checked by a
conformance suite over the Khronos samples, with corrupt files rejected and decoding in workers. The renderer
already draws models through three.js's `GLTFLoader` on the main thread (ADR 0037), which ADR 0020 rules out for
Draco and meshopt: its decoders start Blob-URL workers and bring their own pools. ADR 0020 §7 decided that geometry
codecs decode in the engine's worker pool to flat typed arrays. The survey is
[`docs/research/compression.md`](../research/compression.md); the models and quality track (`docs/parallel-tracks.md`,
track C) builds the CPU side in a new package without touching `core` or `renderer`.

## Options considered

1. **Keep `GLTFLoader` and plug decoders into it.** Least code, but parsing stays on the main thread, the decoders'
   workers stay outside ADR 0011, and the loader's three.js objects cannot cross a worker boundary.
2. **loaders.gl's glTF loader** (MIT). Maintained, but it fetches Draco from a CDN by default (survey §6, loaders.gl
   #3185) and brings its own worker framework; its output is still converted for three.js.
3. **Our own parser to a renderer-neutral description, decoders from maintained libraries.** A glTF reader is
   mostly validation and accessor copying (the specification is small); Draco comes from Google's `draco3d`
   (Apache-2.0) and meshopt from `meshoptimizer` (MIT), both used through their documented APIs.

## Decision

Option 3, in `@vibeglobe/models`:

- `parseModel(bytes, { resources, draco, meshopt, limits })` reads GLB (header, chunk bounds and alignment checked)
  or glTF JSON, validates the document (every index, accessor and buffer view bounds, a node forest, required
  extensions limited to `SUPPORTED_EXTENSIONS`), resolves buffers and images (GLB BIN, `data:` URIs, supplied
  external files, meshopt fallback buffers), decodes meshopt views and Draco primitives, applies sparse accessors,
  de-interleaves attributes, composes node transforms and returns a `ModelDescription`: tightly packed typed arrays
  that own their buffers (transferable), PBR metallic-roughness materials (with `KHR_texture_transform`,
  `KHR_materials_unlit`, `KHR_materials_emissive_strength`), encoded images sniffed by signature (PNG, JPEG, WebP,
  KTX2; `KHR_texture_basisu` and `EXT_texture_webp` keep the plain image as `fallbackImage`), one instance per node
  with a mesh, bounds and counters. Coordinates stay glTF's (+Y up, meters): the renderer's pose (ADR 0037) turns
  them onto east-north-up.
- Every failure is a `ModelError` with a code (`invalid-glb`, `invalid-json`, `invalid-gltf`, `unsupported`,
  `missing-resource`, `decode-failed`, `too-large`); a size limit (default 256 MiB declared) applies before decoding.
- `createModelTasks()` is a worker task table (`parse-model`) for the engine's worker program; the decoders load
  lazily inside the worker, only for models that need them. `createModelLoader({ run })` runs on the main thread: it
  fetches the file and, for a `.gltf`, the external files its (validated) document names, then runs the task
  (`poolRunner(pool)` adapts the engine's pool).
- Draco: `draco3d` 1.5.9 as published (its decoder module with `locateFile` for the consumer-hosted `.wasm`, ADR
  0015). ADR 0020 asked for a rebuild as an ES module without dynamic execution; no Emscripten toolchain is available
  here, so the rebuild and the bitstream-count validation of Draco #1169 are in `docs/hardening-backlog.md`.
- KTX2 textures are passed through as encoded bytes; the renderer transcodes them with the existing
  `transcode-ktx2` task (ADR 0020).

## Consequences

- The renderer builds its meshes from `ModelDescription` instead of `GLTFLoader` (hook request in
  `docs/parallel-tracks.md`), and the worker program registers `createModelTasks()`; until then F361's Draco and
  conformance steps pass in Node and the renderer keeps its current path.
- Verified by the conformance suite over eleven Khronos samples in sixteen variants (`conformance.test.ts`: counts,
  declared bounds, equality across `.gltf`/`.glb`/embedded/interleaved/Draco, meshopt equal to the uncompressed data,
  sparse accessors, primitive modes, node transforms, KTX2 selection), fuzzed truncation and corruption of GLB, Draco
  and meshopt input (`corrupt.test.ts`), and the loader across a structured-clone boundary (`loader.test.ts`).
