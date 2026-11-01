# 0020. GPU texture compression and compressed geometry

- Status: Accepted
- Date: 2026-10-21
- Milestone: M3 (KTX2 imagery, F104); M10 and M13 (Draco and meshopt geometry)

## Context

`PLAN.md` asks for GPU-compressed textures (KTX2/Basis) where supported, to reduce memory and upload time, with a fallback where they are not (F104). The constraints that shape the answer:

- ADR 0007: uploads at most 2 ms and 8 MB per frame, and exact byte accounting for the GPU and RAM budgets.
- ADR 0011: WebAssembly runs only in workers; workers and WebAssembly load from configurable same-origin URLs; no `blob:` workers, `eval`, `new Function` or CDN; the page needs no `'unsafe-eval'` and the worker only `'wasm-unsafe-eval'`; the worker program stays within 100 KB min+gzip, lazily loaded WebAssembly excluded.
- ADR 0010: three.js 0.186.1 is the renderer base and is imported only in `@vibeglobe/renderer`.
- Permissive licenses only.

The survey [docs/internal/research/compression.md](../research/compression.md) studied Basis Universal, KTX-Software, Draco, meshoptimizer, CesiumJS, three.js, Babylon.js, loaders.gl and 3DTilesRendererJS at pinned commits, with their issue trackers, and measured on the container's Chromium 141 with SwiftShader:

- three.js's bundled Basis transcoder fails under `script-src 'self' 'wasm-unsafe-eval'` with an `EvalError` (embind generates functions; three.js #34389).
- SwiftShader exposes BC, ETC2 and ASTC on both WebGPU and WebGL2, so CI can exercise every target.
- An ETC1S 256 px tile transcodes in 0.55–1.25 ms, against 1.5 ms (JPEG) and 2.6 ms (WebP) to decode an image.
- With mipmaps, BC7 takes a quarter of RGBA8's GPU memory and BC1 an eighth.
- ETC1S files are about the size of WebP at 4–5 dB lower PSNR than JPEG q85; UASTC is close to JPEG quality at 3.5–4.5 times the size.
- meshopt decodes at about 1.3 GB/s.
- three.js r186 counts every compressed texture as 1 byte in `info.memory`, and CesiumJS queries a misspelled ETC extension name (`WEBG_compressed_texture_etc`), so it never detects ETC2.

## Options considered

1. **Use three.js's `KTX2Loader`, `DRACOLoader` and meshopt `useWorkers`.** Least code. Rejected: they start workers from Blob URLs (ADR 0011), the transcoder needs `'unsafe-eval'` (measured), and they bring their own worker pools and loaders outside the ADR 0007 scheduler.
2. **Transcode on the main thread** (the CesiumJS imagery path for some formats, 3DTilesRendererJS's synchronous meshopt). Rejected: 0.5–1.3 ms per tile on the main thread breaks the frame budget during streaming, and WebAssembly belongs in workers (ADR 0011).
3. **Encode every JPEG/PNG/WebP tile to BC1 or ETC2 in workers.** Would give every provider the memory saving, at CPU and quality cost. Not adopted in M3; it is open question 1 of the survey, with a measurement plan.
4. **Chosen:** keep image sources on the image path; transcode KTX2 sources in the existing worker pool with our own CSP-clean build of the upstream Basis Universal transcoder; upload through three.js's compressed textures from the ADR 0007 queue; decode Draco and meshopt geometry in workers when glTF and 3D Tiles arrive. The survey's section 7 gives the details; the rules are below.

## Decision

1. **Image sources keep their formats.** JPEG, PNG and WebP tiles decode in a worker to `ImageBitmap` and upload as RGBA8 with GPU mipmaps. This is the F104 fallback and the only path for providers without KTX2.
2. **KTX2 sources** (declared, or detected from `image/ktx2` or the KTX2 magic) with ETC1S or UASTC LDR 4x4 are transcoded in the worker pool, all levels of a tile in one task. KTX2 files that already hold a block format the device supports pass through. Tiles must be a multiple of 4 in size, 2D, with a full mip chain; others are transcoded to RGBA32 and get GPU mipmaps, with one warning per source.
3. **Targets**, chosen once per source by one pure function in `core`: on devices with BC, BC1 for opaque ETC1S and BC7 for ETC1S with alpha and for UASTC; without BC, ETC2 for ETC1S and ASTC 4x4 for UASTC (ETC2 when ASTC is missing; RGBA8 for non-color UASTC without ASTC); RGBA8 when nothing is compressed. BC is preferred wherever it exists, because desktop drivers can expose emulated ETC2 and ASTC. Imagery uses the sRGB variants. Capabilities come from the WebGPU features `texture-compression-bc`, `-etc2` and `-astc` (three.js r186 already requests them) and the WebGL2 extensions for S3TC (with sRGB), BPTC, ETC and ASTC; a unit test checks the queried names against the registries' spelling.
4. **Transcoder:** the upstream Basis Universal transcoder (Apache-2.0), pinned, built to WebAssembly with a plain C interface and no Emscripten JavaScript glue, containing only ETC1S, UASTC, Zstandard and the targets above, at most 150 KB gzip (`npm run size`). Fallback build: the standard one relinked with `-sDYNAMIC_EXECUTION=0` as an ES module. It is a content-hashed file loaded lazily from `assets.wasmBaseUrl` by each worker on its first KTX2 task, so apps without KTX2 never download it. A small original TypeScript reader validates the container and predicts bytes before any WebAssembly runs. If WebAssembly is refused, KTX2 sources fail with a typed `format-unsupported` error; there is no JavaScript transcoder.
5. **Uploads:** the renderer builds a three.js `CompressedTexture` (no mipmap generation, no flip, color space from the KTX2 transfer function) and uploads it with `initTexture()` from the ADR 0007 queue. A tile's whole mip chain uploads in one frame (a 512 px BC7 tile is 350 KB). The upload cost model keeps separate averages for compressed and uncompressed uploads.
6. **Byte accounting:** compressed textures count the exact sum of blocks per level, not ADR 0007's ×4/3 rule; the engine's counters are the source of truth (three.js's `info.memory` cannot be), cross-checked in tests with `TextureUtils.getByteLength`.
7. **Geometry:** terrain needs no codec, since the engine builds terrain meshes from height grids (ADR 0006, 0013). glTF (M10) and 3D Tiles (M13) need both Draco (Google Photorealistic 3D Tiles) and meshopt (gltfpack, Cesium ion). Both decode in worker tasks to flat typed arrays: meshopt from its upstream ES module (MIT), Draco rebuilt as an ES module without dynamic execution (Apache-2.0), both lazily loaded, with bitstream counts validated before decoding and WebAssembly memory capped. VibeGlobe's own pipeline (M9) emits meshopt.

## Consequences

- **Easier:** KTX2 sources cut GPU memory 4–8 times and upload time with it, through the same scheduler, worker pool, upload queue and budgets as every other tile; CI tests every target on SwiftShader; strict-CSP deployments keep working.
- **Harder:** a WebAssembly build of the transcoder (and of Draco in M10) is committed with its build script and pinned toolchain, rebuilt nightly and compared by hash; its license goes into `THIRD_PARTY_NOTICES.md`. Shaders and caches must handle one more texture variant per format family.
- **Open questions** (survey section 8): real-time encoding of image tiles; ETC1S to BC1 versus BC7 quality (keep BC1 unless BC7 is more than 0.5 dB better); whether WebGPU ever exposes emulated formats; the transcoder's final size; Zstandard-supercompressed raw formats and XUASTC; sharing compiled WebAssembly between workers; quantized terrain vertices (M4); where glTF is parsed (M10, M13).
- **Verification (M3, F104):** KTX2 fixtures generated by a pinned `basisu` (ETC1S and UASTC, opaque and alpha, broken variants); unit tests of target selection, the reader, the transcoder task against golden hashes and PSNR, byte accounting and fuzzing; end-to-end tests on both backends that render each forced target and the RGBA8 fallback within ADR 0012's thresholds of the JPEG source, check the GPU byte reduction, run under the strict CSP, and confirm that an app without KTX2 never fetches the transcoder; benchmarks of transcode and upload time per target and of the standard flight with a KTX2 source, recorded here.

## Update 2026-10-21: implementation and measurements (F104)

Decided by the agent; the owner may revisit (open question 21).

- **Toolchain.** No Emscripten toolchain could be installed in the build container, so `scripts/wasm-basis.sh` builds the transcoder with wasi-sdk 25 (download checked by SHA-256) from Basis Universal v1.60 (commit `323239a`) as a WASI reactor module: the plain C interface of `packages/worker/wasm/basis-transcoder.cpp`, no JavaScript glue, `memory` and seven functions exported, and five WASI imports (`fd_*`, `random_get`) that the worker stubs with "not supported". The build is reproducible: a rebuild from a fresh checkout gives the committed bytes. No CI job rebuilds it (owner's simplicity rule, `docs/internal/simplification.md` item 1); the script runs when the transcoder is upgraded.
- **Size.** Compiled in: ETC1S, UASTC LDR 4x4, Zstandard, and the BC1, BC7, ETC1/ETC2 (with EAC alpha), ASTC 4x4 and RGBA32 targets; out: PVRTC, ATC, FXT1, EAC R11/RG11, BC4/BC5, UASTC HDR and the higher-quality ETC1S→ASTC tables (ETC1S goes to ASTC only on devices with neither BC nor ETC2). The result is 435 KB, **204 KB gzip**, above rule 4's estimate of 150 KB: five 61 KB lookup tables (ETC1S to BC1, BC7 and ASTC) dominate, and no combination of the upstream switches meets 150 KB (a BC-only build is still 170 KB). One build loaded lazily on the first KTX2 tile is simpler than one per format family; `npm run size` gates it at 210 KB.
- **Reader and targets.** `packages/core/src/imagery/ktx2.ts` validates the container (identifier, header, level index ranges, descriptor; at most 4096 px, 2D only) and picks the target with rule 3; `transcode-ktx2` in `@vibeglobe/worker` runs it, then the transcoder per level, and returns the levels with their exact byte count. Raw block files pass through when the device decodes them. Errors are typed: `undecodable` for broken files (a `corrupt` tile error), `format-unsupported` for valid files the engine or device cannot use and when the transcoder cannot load (an `unsupported` tile error, never retried). `createRenderer({ compressedTextures })` limits the families used, for tests and emulating drivers; `RendererStats.compressedTextures` counts compressed tile textures.
- **Fixtures.** The fixture server encodes `.etc1s.ktx2` and `.uastc.ktx2` tiles with a full chain using the Basis encoder that `@loaders.gl/textures` 4.5.4 ships (Binomial's WebAssembly build, dev dependency only), instead of a pinned `basisu` binary.

Measurements (`e2e/imagery-ktx2.spec.ts`, Chromium 141 with SwiftShader, 122 Mercator tiles of 256 px at level 3, each with its full chain):

| Target                   | GPU bytes per tile | vs RGBA8 | PSNR vs PNG source | Pixels differing from the RGBA8 transcode (ADR 0012 cross-backend threshold) | Upload ms per tile, median (WebGPU / WebGL2) |
| ------------------------ | -----------------: | -------: | -----------------: | ---------------------------------------------------------------------------: | -------------------------------------------: |
| PNG decoded to RGBA8     |            349,524 |       1× |                  — |                                                                            — |                                  0.34 / 0.15 |
| ETC1S → BC1              |             43,704 |      1/8 |            32.2 dB |                                                                       0.006% |                                  0.06 / 0.05 |
| ETC1S → ETC2 RGB         |             43,704 |      1/8 |            32.3 dB |                                                                       0.002% |                                  0.05 / 0.01 |
| ETC1S → RGBA8 (fallback) |            349,524 |       1× |            32.0 dB |                                                                            — |                                  0.34 / 0.15 |
| UASTC → BC7              |             87,408 |      1/4 |            43.8 dB |                                                                       0.000% |                                  0.07 / 0.05 |
| UASTC → ASTC 4x4         |             87,408 |      1/4 |            44.1 dB |                                                                       0.000% |                                  0.06 / 0.07 |
| UASTC → RGBA8 (fallback) |            349,524 |       1× |            66.0 dB |                                                                            — |                                  0.34 / 0.15 |

In the browser, every target renders like the RGBA8 transcode of the same files within ADR 0012's cross-backend tolerance, on both backends; UASTC also renders like the PNG source within it. ETC1S differs from the source in 0.5% of the pixels (the fixture's one-pixel grid lines), which is the codec's loss, not the GPU format's: its RGBA8 transcode differs just as much. In Node the transcode itself takes about 1 ms per 256 px tile. Software-GPU timings are indicative only (ADR 0012); the reference devices will give the real ones.
