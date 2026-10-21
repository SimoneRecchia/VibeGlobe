# 0010. Renderer base: three.js WebGPURenderer pinned to 0.186.1

- Status: Accepted (partly superseded by 0013 and 0015)
- Date: 2026-10-20
- Milestone: M2

## Context

`PLAN.md` fixes the backend requirements:

- WebGPU as the primary backend, with an automatic WebGL2 fallback;
- the same picture and the same API on both backends;
- minimal draw calls and state changes, and no redundant uploads;
- uploads spread across frames within a budget;
- recovery from device or context loss without reloading the page;
- a `destroy()` that frees everything, with several instances per page;
- a strict Content Security Policy (CSP) and SSR-safe imports;
- only permissively licensed dependencies.

The Architecture guidance and the decision log recommend three.js, and [architecture §9](../plan/architecture.md) marks that choice Proposed. The research behind this decision is in [docs/research/gpu-and-renderer.md](../research/gpu-and-renderer.md). It covers code study of nine engines, 23 issue-tracker failure modes, and measurements made with three.js 0.186.1 in headless Chromium on SwiftShader.

Version facts as of 2026-10-20:

- npm `three` latest is 0.186.1, published 2026-09-24. Its gitHead is 9b4a2ac, the commit tagged r186.
- `@types/three` latest is 0.186.0.
- Both are MIT licensed (copyright © 2010–2026 three.js authors).
- r187 is not yet released. It carries fixes this engine needs:
  - the WebGL2 fallback never deletes programs, shaders or vertex array objects (VAOs) ([#34597](https://github.com/mrdoob/three.js/issues/34597));
  - a WebGL context restore is never handled ([#34682](https://github.com/mrdoob/three.js/issues/34682));
  - new bind groups re-upload a disposed texture ([#34999](https://github.com/mrdoob/three.js/issues/34999)).

Other ADRs already rely on three.js r186:

- the camera-relative TSL transform of [ADR 0004](0004-precision-strategy.md);
- `reversedDepthBuffer` and an engine-owned projection in [ADR 0005](0005-depth-strategy.md);
- the upload queue and RAM tier of [ADR 0007](0007-scheduling-and-caching.md);
- worker decoding in [ADR 0011](0011-workers.md);
- SwiftShader WebGL2 and WebGPU in CI under [ADR 0012](0012-test-tooling.md).

## Options considered

1. **three.js `WebGPURenderer`, behind `RendererBackend`.**
   - **How it works:**
     - The WebGPU backend falls back to WebGL2 automatically when `init()` fails, and `forceWebGL` forces WebGL2.
     - TSL (the three.js Shading Language) compiles one shader source to WGSL and GLSL.
     - Pipelines are cached and `compileAsync` precompiles them. `initTexture` uploads a texture explicitly.
     - `info.memory` keeps byte accounting.
   - **Pros:** MIT; TypeScript and ESM with no WASM; no `eval`; imports safely under Node.
   - **Cons:**
     - No restore after a loss: `render()` simply stops.
     - On WebGL2, one uniform buffer per object makes many draws expensive ([#30560](https://github.com/mrdoob/three.js/issues/30560)), and node building is per material ([#33821](https://github.com/mrdoob/three.js/issues/33821)).
     - The WebGL2 path leaks GL objects in r186.
     - Releases are frequent and break APIs.
     - The bundle is 258 KB gzip.
   - **Measured, 400 tiles:**
     - **One material per tile:** `compileAsync` 0.6–0.8 s, linear in the material count.
     - **One shared material with object-scope texture and matrix bindings:**
       - `compileAsync` 56–149 ms, flat;
       - `render()` CPU 1.9–3.9 ms median on WebGL2 and 2.9 ms on WebGPU;
       - the correct texture per tile, on both backends.
     - **The same tiles as one instanced draw from a texture array:** 0.2 ms.
     - **50 evict-and-add cycles:** texture counts stable.
2. **Babylon.js (`WebGPUEngine` and `Engine`, Apache-2.0).**
   - **How it works:** `EngineFactory` picks the backend automatically; buffers, textures and render targets are fully restored after a loss.
   - **Pros:** mature restore; caches; snapshot rendering.
   - **Cons:**
     - Restore keeps a CPU copy of every texture.
     - Shaders are hand-written twice (WGSL and GLSL), or GLSL is converted by glslang and Tint WebAssembly (WASM) modules that load from Babylon's CDN by default.
     - Its scene model and culling duplicate ours.
     - The minimal bundle is 240 KB gzip.
3. **PlayCanvas (MIT).**
   - **How it works:** backends are tried in order.
   - **Pros:**
     - the best loss recovery studied: both backends, with a debug hook that forces a real loss;
     - `UploadStream` with pixel buffer objects (PBOs) and staging buffers;
     - uniforms in dynamic-offset buffers.
   - **Cons:** shaders exist twice (267 GLSL and 290 WGSL chunk files), and the 565 KB gzip bundle includes its application framework.
4. **Custom backend on raw WebGPU and WebGL2.**
   - **Pros:** full control of staging, dynamic offsets and restore; the smallest bundle.
   - **Cons:**
     - two backends to write;
     - two shader languages, or a translator, to maintain;
     - months before the first globe.
   - The decision log rejects it as a starting point. It remains the escape hatch for hot paths that profiling proves.
5. **WASM engines: Bevy/wgpu, Filament, bgfx.**
   - **Cons:**
     - a Rust or C++ toolchain, large WASM, and CSP `wasm-unsafe-eval` on the page;
     - offline shader compilers;
     - Bevy picks its web backend at compile time, with no runtime fallback;
     - device loss quits or is fatal.
6. **CesiumJS renderer.** WebGL2 only, and no context-loss handling at all ([cesium#5991](https://github.com/CesiumGS/cesium/issues/5991)).

## Decision

Option 1. three.js is adopted as the rendering base at **exactly `0.186.1`**, under the following rules.

### 1. Pin

- `packages/renderer/package.json` depends on `"three": "0.186.1"`. `@types/three` is an exact `0.186.0` dev dependency, never a runtime one.
- Imports come only from `three/webgpu` and `three/tsl`, and only inside `packages/renderer`. The dependency-rule check enforces this (F051).
- No three.js type appears in any public API. `layers` uses helpers exported by the renderer.
- The license and copyright go into the third-party notices.

### 2. Backend selection

- The option is `backend: 'auto' | 'webgpu' | 'webgl2'`; the playground also accepts `?backend=`.
  - `webgl2` sets `forceWebGL: true`.
  - `webgpu` disables the fallback; tests use it.
  - `auto` relies on the three.js fallback when `init()` fails.
- **Startup self-test on WebGPU:**
  - The renderer uploads a mipmapped probe texture and renders the warm-up scene once into a render target, with `onError` and `onDeviceLost` hooked.
  - Any GPU error or loss triggers a dispose and a re-initialization with `forceWebGL`, and emits `backend-fallback` with the reason.
  - Measured case it catches: r186 sends `swizzle: 'rgba'` in every texture-view descriptor, and Chromium 141 rejects it.
- **No backend available:** the engine emits a typed `unsupported-device` error and leaves the host page running (F055). The active backend is exposed in the API and the debug overlay.

### 3. Engine-owned scene state

- The engine owns one `Scene` per instance, with `matrixWorldAutoUpdate = false`.
- Every engine object sets `matrixAutoUpdate`, `matrixWorldAutoUpdate` and `frustumCulled` to `false` (F052).
- Engine shaders set `material.vertexNode` from engine uniforms:
  - the split per-draw offsets and rotation-only view of ADR 0004;
  - the projection of ADR 0005, built for the active backend's clip space.
- TSL's default float32 `modelViewMatrix` is never used.
- Opaque order comes from `renderOrder`, which carries an engine sort key: pass, then material variant, then a front-to-back distance bucket. Translucent order is back to front.

### 4. Materials and pipelines

- Each material variant has one shared `NodeMaterial`. A variant is a combination of layer kind, blend mode, the morph variant of ADR 0004 and the depth path of ADR 0005.
- Per-tile textures and uniforms are object-scope nodes (`onObjectUpdate`) that read the tile record.
- A material per tile is forbidden.
- Before the first frame, `compileAsync` compiles a warm-up scene that contains one object per variant. The debug overlay counts pipeline creations after warm-up, and the count must stay 0.

### 5. Geometry

- Imagery tiles, and heightmap terrain tiles, share one grid geometry per resolution.
- Per-tile vertex buffers exist only for formats that require them, such as quantized-mesh. They are disposed on eviction.
- On r186 each distinct geometry leaks a VAO on WebGL2 (#34597). Per-tile geometry therefore ships only after the r187 upgrade in rule 9.

### 6. Uploads

- A tile becomes drawable only after an explicit upload, drained from the ADR 0007 queue within its time and byte budget:
  - `renderer.initTexture()` for textures;
  - `compileAsync(mesh)` for per-tile meshes.
- Workers decode images (ADR 0011) with `premultiplyAlpha: 'none'` and `colorSpaceConversion: 'none'` ([#31132](https://github.com/mrdoob/three.js/issues/31132)).
- Textures set `flipY = false` and `premultiplyAlpha = false`; tile UVs follow the image orientation; sRGB is declared through `colorSpace`. As a result, neither backend converts anything at upload.
- Bytes are counted as texels × bytes per texel × 4/3 for the mip chain, and checked against `info.memory.texturesSize`. On WebGPU, upload work is queued and invisible to JavaScript timing, so the cost model is calibrated with timestamp queries.

### 7. Batching

- Each tile is one draw with its shared material (measured 5–10 µs of CPU per draw).
- **Pre-approved switch:** if M2 measures WebGL2 renderer CPU p95 above 3 ms at the reference tile count on the reference desktop, imagery moves to texture pages. The pages are 2D array textures filled by GPU copies (`copyTextureToTexture` per mip level), with tile records as instanced attributes and one instanced draw per variant.
- `BatchedMesh` is not used ([#28776](https://github.com/mrdoob/three.js/issues/28776); on WebGPU it is a loop of single draws).

### 8. Device or context loss: engine-level recovery

- Loss handlers ignore events from destroyed or replaced renderers. Measured: disposed renderers report reason `unknown`, and three.js filters only `destroyed`.
- When a live renderer is lost, the engine:
  1. stops drawing and emits `renderer-lost`, leaving the old canvas in place;
  2. creates a new canvas and a new renderer with the same backend preference; a refused WebGPU adapter falls back to WebGL2;
  3. marks every GPU resource non-resident;
  4. re-decodes the pinned base from the RAM tier and uploads it first (ADR 0007), and compiles the warm-up scene;
  5. swaps the canvases and emits `renderer-restored`;
  6. refills everything else through normal scheduling.
- Recovery is limited to 3 attempts in 60 s, with backoff. After that the engine emits a typed `renderer-failed` error and shows a static message.
- What recovery never does:
  - strobe ([bevy#23183](https://github.com/bevyengine/bevy/issues/23183));
  - call `alert()`;
  - leave a rejection unhandled ([playcanvas#9675](https://github.com/playcanvas/engine/issues/9675)).
- Every asynchronous GPU call, such as a read-back, checks that the renderer is still live first ([playcanvas#6677](https://github.com/playcanvas/engine/issues/6677)).

### 9. Lifecycle, read-backs and upgrades

**Lifecycle.** `destroy()` proceeds in order:

1. remove the engine's objects from the scene;
2. dispose textures, geometries, materials and render targets;
3. call `renderer.dispose()`, which releases the WebGL context ([cesium#11533](https://github.com/CesiumGS/cesium/issues/11533));
4. remove the canvas and the listeners.

**Read-backs.** One helper normalizes read-backs: WebGPU pads rows to 256 bytes, and WebGL2 returns rows bottom-up.

**Upgrades.**

- Pins stay exact: three.js versions are 0.x, and every minor release may break APIs.
- Upgrades go one release at a time:
  - read the three.js Migration Guide for each release;
  - update `three` and `@types/three` together, in a dedicated change.
- An upgrade passes the full gate:
  - type check and unit tests;
  - renderer tests on both backends;
  - visual regression and scenario detectors;
  - leak suite: 100 mount/unmount cycles plus GL object counters from a wrapped context;
  - loss chaos tests;
  - benchmarks against the recorded baseline, with no budget regression;
  - bundle size.
- The version and the benchmark comparison go into the renderer's `CLAUDE.md` and the changelog. An upgrade needs a new ADR only when it changes a rule here.
- r187, or the first later release that passes the gate, is **required before M4 starts**. Every new release is evaluated at least once per milestone.

### Features relied on and their WebGL2 maturity

| Feature                                                                             | Use                                | Maturity on the WebGL2 path                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WebGPURenderer` automatic fallback, `forceWebGL`                                   | Backend selection, tests           | Mature. Fallback happens only when `init()` fails, which is why the self-test exists. three.js runs its TSL unit tests on both backends through `forceWebGL`.                                                                                                                                                                                 |
| TSL: `vertexNode`, `colorNode`, `uniform`, `attribute`, `texture`, `onObjectUpdate` | Every engine shader                | Works; measured correct on both backends. WebGL2 has no storage buffers: storage-buffer nodes such as `instancedArray` are emulated and have open gaps ([#31221](https://github.com/mrdoob/three.js/issues/31221)). Subgroups are unsupported. Compute shaders are emulated with transform feedback. The engine's core paths avoid all three. |
| `matrixAutoUpdate`, `matrixWorldAutoUpdate` and `frustumCulled` set to `false`      | Engine computes matrices and culls | Mature; backend-independent flags checked in the shared `Renderer`.                                                                                                                                                                                                                                                                           |
| `initTexture` and `compileAsync`                                                    | Explicit uploads and warm-up       | Works. WebGL2 uses `texStorage` with `texSubImage` and `generateMipmap`, plus `KHR_parallel_shader_compile` when available. Per-material node building costs 1–2 ms ([#33821](https://github.com/mrdoob/three.js/issues/33821)).                                                                                                              |
| `InstancedMesh`, array textures, `copyTextureToTexture`                             | Escape hatch in rule 7             | Works. Uncompressed arrays have no per-layer mip upload (a GPU copy is used instead). A full array upload from the CPU is slow (1.4–1.7 s per 100 MB).                                                                                                                                                                                        |
| `info.memory`, `onDeviceLost`, `onError`                                            | Budget checks, recovery            | Counts are reported; there is no restore before r187 ([#34682](https://github.com/mrdoob/three.js/issues/34682)).                                                                                                                                                                                                                             |
| `reversedDepthBuffer`                                                               | ADR 0005                           | Needs `EXT_clip_control`, which Firefox lacks ([#33166](https://github.com/mrdoob/three.js/issues/33166)); ADR 0005 defines the fallback.                                                                                                                                                                                                     |

### Relation to architecture §9

This ADR confirms the proposal, with five changes:

1. **Loss recovery** recreates the renderer and its canvas and re-decodes from the RAM tier. The proposal restored GPU resources in place from CPU caches, which r186 cannot do.
2. **A WebGPU startup self-test** is added.
3. **Texture arrays** become a measured fallback, used only when the M2 benchmark triggers rule 7, instead of the default imagery path. Tiles otherwise share materials and geometry.
4. **"Last good frame"** depends on how a lost WebGL canvas behaves, which M2 measures.
5. **Bundle budget:** three.js alone takes about 258 KB of the 300 KB initial-JavaScript budget proposed in `docs/plan/quality.md`. That budget goes to the owner for review in M2.

## Consequences

**Easier.**

- One shader source and one API for both backends.
- No WASM and no `eval`, so the CSP stays strict and imports stay SSR-safe.
- Globe work starts immediately.

**Harder.**

- The engine owns budgets, sort order and loss recovery, and relies on three.js internals where it must:
  - object-scope nodes;
  - `renderer.backend` for timestamp queries and WebGPU error scopes.
- Each three.js upgrade is real work.
- Until r187, per-tile meshes are blocked on WebGL2.

**Follow-up work.**

- **M2:**
  - `RendererBackend` with the rules above;
  - the self-test;
  - recovery and chaos tests;
  - renderer bundle budget;
  - benchmarks of 200, 400 and 800 tile draws per backend on the reference devices.
- **M3:** the upload cost model.
- **Before M4:** the r187 upgrade.

**Verification.**

| Check         | Covers                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------- |
| F051          | Exact pin; three.js imported only inside the renderer                                        |
| F052          | Matrix updates and culling off; uploads counted per frame                                    |
| F053          | WebGPU selected by default                                                                   |
| F054          | WebGL2 fallback, including a simulated adapter failure                                       |
| F055          | Typed `unsupported-device` error                                                             |
| Chaos suite   | Injected `GPUDevice.destroy()` and `WEBGL_lose_context`; recovery without reloading the page |
| Leak suite    | Heap, `info.memory` and GL object counts flat over 100 mount/unmount cycles                  |
| Debug overlay | Zero pipeline compiles after warm-up                                                         |

## Update 2026-10-20

Point 5 is settled by the owner ([ADR 0015](0015-owner-decisions-2026-10-20.md), decision 12): no separate lightweight first-frame path. M2 measures three.js after tree-shaking, time to first frame (at most 1 s from a LAN server) is the binding target, the initial-JavaScript byte budget is set from the measurement with a CI size check that blocks regressions (F546), and host apps can load the engine through a dynamic import (F547). The 300 KB proposal is withdrawn.

## Update 2026-10-21

M2's measurements (F546, F547):

- **three.js 0.186.1 after tree-shaking**, as a minimal globe uses it (`WebGPURenderer` with its WebGL2 fallback and node materials): 233.1 KB gzip. The engine adds 12.8 KB, so the whole initial JavaScript of a minimal globe (core, renderer and controls, dynamic imports included) is 245.9 KB gzip (902 KB minified).
- **Budgets** (`quality/budgets.json`, `initialJs`): 236 KB for three.js's share, about 1% above the measurement, so pulling in any further three.js module fails. 351 KB in total: the three.js budget plus the core, renderer and controls package budgets. `npm run size` checks both in the fast CI job. A scratch commit that pulled in the classic `WebGLRenderer` (three.js's share 316 KB) failed only that step ([CI run 39522798647](https://github.com/SimoneRecchia/VibeGlobe/actions/runs/39522798647)) and was reverted.
- **Time to the first complete frame:** from navigation to the first frame with every tile and the base imagery drawn, served by a local server (`vite preview`). Median 456 ms over five fresh page loads in the cloud container with the software GPU. `npm run bench` checks the median against the 1 s budget (`quality/budgets.json`, `startup`).
- **Lazy loading:** a host can import the engine with a dynamic import after a user action. Nothing of the engine or three.js is downloaded before it (`apps/lazy-host`, `e2e/lazy-host.spec.ts`).

## Update 2026-10-21

The start-up self-test of §2 and the warm-up of §4 were missing from the first M2 renderer (M2 review). Now:

- **Self-test** (`warm-up.ts`). On WebGPU, right after `init()`, the renderer uploads a 4 × 4 mipmapped probe texture and draws the surface shader with it into a 4 × 4 render target inside `validation`, `out-of-memory` and `internal` error scopes, then waits for the queue. A thrown error, a scope error or a device loss disposes the renderer, destroys its device and starts WebGL2 on a new canvas, with `backend-fallback` naming the self-test and the reason; a forced `webgpu` backend fails with `unsupported-device` instead. An OffscreenCanvas cannot be replaced, so there the fallback ends in `renderer-failed`. End-to-end tests break every texture view (an impossible mip level count) and check both outcomes.
- **Warm-up.** Before the first frame, and again after a recovery, `compileAsync` compiles a scene with one triangle per material variant laid out like a tile (in M2 the surface material of the active depth path), then one empty frame compiles three.js's output pass. `RendererStats.pipelineCompiles` counts pipelines created afterwards and the debug overlay shows it; an end-to-end test drags and zooms on both backends and requires 0.
- **Giving up.** After the third recovery within a minute, besides the `renderer-failed` error, a static message (`role="alert"`, class `vibeglobe-renderer-failed`) replaces the canvas, as §8 requires (second M2 review). Its wording is English until the localization milestone.
- **Releasing.** Destroying the renderer deletes every vertex array three.js still caches, its output-pass quad's included (KB-030).

## Update 2026-10-21 (benchmarks and leak suite)

The second M2 review found the tile-draw benchmarks and the leak suite of the follow-up list missing. Now:

- **Tile-draw benchmarks.** `npm run bench` runs `drag-200`, `drag-400` and `drag-800` on each backend: continuous circular dragging through the navigation API (`?scenario=drag`) at views whose tile counts are set by the coarsest surface level (`GlobeOptions.minSurfaceLevel`, playground `?level=`): 208, 426 and 833 draws per frame at 1280 × 720. Each run records its draw count. The CPU sample covers the engine's whole frame, from the animation-frame callback to the engine's `frame` event. Budgets are the targets of `docs/plan/quality.md` (frame p95 17.2 ms, CPU p95 6 ms), binding on real GPUs. In the cloud container on SwiftShader, which rasterizes on the same CPU, the CPU p95 is 4.8, 9.0 and 16.3 ms on WebGL2 and 8.2, 9.8 and 20.9 ms on WebGPU; those numbers say nothing about the reference desktop, so the rule 7 decision waits for the hardware run (F075, `docs/guides/hardware-testing.md`).
- **Cold starts.** The same command measures 10 cold starts (a fresh browser context with the HTTP cache disabled through the DevTools protocol) and checks their p90 against the 1 s target (`startup.firstFrameP90Ms`), as ADR 0012 specifies; the median over the scenario runs is still checked. Container: p90 724 ms.
- **Leak suite** (`e2e/globe-leaks.spec.ts`). After 10 warm-up cycles, 100 mount/unmount cycles per backend, each mounting a globe in a new element, waiting for its first frame and destroying it. Before and after: the JS objects of a heap snapshot after a full collection (V8's compiled code and native records excluded: JIT tiering keeps compiling code long after the warm-up), instances per constructor, DOM nodes and event listeners (DevTools counters), and live GPU objects (WebGL2 objects not deleted in contexts not lost; WebGPU devices not destroyed with their buffers and textures). Every count must return to its value, and the heap may move by at most 64 KB. Measured: −1.1 KB (WebGL2) and −1.4 KB (WebGPU), no constructor grew by more than 7 instances. A globe kept alive after `destroy()` on purpose fails the suite with 2000 arrays and 600 matrices retained after 20 cycles.
