# 0004. Precision strategy: camera-relative rendering with split per-draw offsets

- Status: Accepted
- Date: 2026-10-20
- Milestone: M2

## Context

GPUs only have 32-bit floats in shaders, on both WebGPU (WGSL) and WebGL2 (GLSL ES). float32 spacing is 0.5 m at ECEF magnitudes and 2 m at Web Mercator magnitudes. The requirements are strict:

- `PLAN.md` asks for no vertex jitter at street level and an M2 zoom from orbit to 1 m above the ground without jitter on both backends.
- F057 and F078 set the bar at 0.1 px of residual motion. At 1 m from the eye with a 1000 px focal length, that is 0.1 mm.
- F047 (float64 camera), F136 (terrain), F367 (data primitives) and F464 (3D Tiles) extend the requirement to every kind of geometry.

The survey [docs/research/precision.md](../research/precision.md) studied CesiumJS, deck.gl/luma.gl, iTowns, OpenGlobus, 3DTilesRendererJS, MapLibre GL JS, osgEarth and three.js. The forces it found:

- **three.js `WebGPURenderer` multiplies view × model on the GPU in float32 by default.** Absolute globe coordinates therefore snap by about 0.5 m ([three.js#30955](https://github.com/mrdoob/three.js/issues/30955), [3DTilesRendererJS#1245](https://github.com/NASA-AMMOS/3DTilesRendererJS/issues/1245)).
- **Shader compilers may reorder arithmetic.**
  - WGSL explicitly allows reassociation.
  - Compensated or relative-to-eye arithmetic broke on Apple, Intel, NVIDIA and Vulkan drivers ([cesium#9417](https://github.com/CesiumGS/cesium/issues/9417), [cesium#12879](https://github.com/CesiumGS/cesium/issues/12879), [deck.gl#8235](https://github.com/visgl/deck.gl/issues/8235), [luma.gl#1764](https://github.com/visgl/luma.gl/issues/1764), [luma.gl#3425](https://github.com/visgl/luma.gl/issues/3425)).
- **GPU trigonometry is inaccurate.**
  - WGSL only guarantees 2⁻¹¹ absolute error.
  - Measured errors were 200–300 m on Mali and Intel, and hundreds of metres under SwiftShader, which the CI uses ([maplibre#7419](https://github.com/maplibre/maplibre-gl-js/issues/7419), [deck.gl#10804](https://github.com/visgl/deck.gl/issues/10804)).
- **The globe-to-flat morph needs two positions per vertex** ([ADR 0008](0008-globe-to-flat-morph.md)). Blending distant absolute positions jitters (Cesium's morph path, [cesium#12879](https://github.com/CesiumGS/cesium/issues/12879)).

`docs/plan/architecture.md` §3 proposed:

- float64 CPU math;
- relative-to-center (RTC) tiles with a float64 eye-relative model-view;
- per-vertex high/low relative-to-eye (RTE) for long primitives;
- morph positions relative to the same center.

## Options considered

1. **RTC per tile with a float64 model-view, as proposed** (Cesium globe tiles, MapLibre Mercator, iTowns, osgEarth).
   - Pros: simple; no per-vertex cost; robust to compilers.
   - Cons: the moving error is about c·u·(D + R), where D is the eye-to-origin distance and R the chunk radius. That is 0.04 px for a level-18 tile at 1 m, but about 2.5 px for a level-12 parent-fallback tile at 1 m. On three.js `WebGPURenderer` it also needs the opt-in CPU path, and `positionWorld` stays absolute.
2. **Per-vertex GPU RTE with high/low attributes** (Cesium 65536 split, deck.gl float-float residual).
   - Pros: any geometry size.
   - Cons:
     - It doubles position attributes, and quadruples them with the morph. Cesium polylines use 13 of the 16 guaranteed attributes.
     - The 65536 split quantizes the eye-relative position to about 4 mm, about 4 px at 1 m ([cesium#11657](https://github.com/CesiumGS/cesium/issues/11657)).
     - Compiler rewriting makes it fall back to absolute float32 (hundreds of px).
3. **Emulated fp64 in shaders** (deck.gl `Fp64Extension`, luma.gl).
   - Pros: about 10⁻¹⁵ relative precision.
   - Cons: about 10× vertex arithmetic, D3D12 compile timeouts, silent loss on Apple and Vulkan, and an integer-arithmetic path required on Metal. deck.gl itself deprecated it.
4. **`renderer.highPrecision = true` with absolute world matrices.**
   - Pros: one flag.
   - Cons: world-space nodes (fog, lights, shadows) stay absolute in float32. It is documented as incompatible with `InstancedMesh` and `SkinnedMesh`. Correctness would hang on a renderer flag.
5. **Floating origin with lazy re-base** (3DTilesRendererJS `ModelViewBatchedMesh`).
   - Pros: no per-frame updates between re-bases.
   - Cons: visible jumps at re-base, and it still needs per-chunk origins.
6. **Camera-relative RTC with a split per-draw offset.**
   - The eye is the world origin, the view matrix is rotation-only, and every chunk adds its float64 eye-relative origin as two float32 parts.
   - Pros:
     - The moving error is about c·u·d, about 0.0002 px at 1 m.
     - If a compiler reorders the sum, it degrades only to option 1, which a chunk-size rule bounds.
     - No per-vertex cost, the same arithmetic on both backends, and no GPU trigonometry.
     - three.js default nodes (including instancing) stay precise.
   - Cons: every geometry needs an origin and a size bound, and the engine writes per-draw data every frame.

## Decision

Option 6. The rules:

1. **float64 everywhere on the CPU.** Geodesy, camera, culling, picking and chunk origins are `Float64Array` math. `Math.fround` appears only in the module that writes GPU data. Absolute positions never reach a shader, and shaders never derive positions from trigonometry or geodesy.
2. **Camera-relative world.**
   - Each frame the world origin is the eye E, with the axes of the current frame: ECEF in the globe phase, the anchor frame of ADR 0008 during and after the morph.
   - The view matrix uploaded is rotation-only. The projection is built in float64 (its form is the depth ADR's decision).
   - Camera state follows [ADR 0009](0009-camera-and-input.md) (float64) and is re-derived every frame, never accumulated in float32.
3. **Chunks with float64 origins.**
   - Every GPU geometry (terrain or imagery tile, data-layer cell, model, 3D Tiles content) has a float64 origin O. Its positions are float32 or quantized offsets from O.
   - Each frame, for each drawn chunk, the CPU computes T = O − E in float64, then T_hi = fround(T) and T_lo = fround(T − T_hi).
   - Engine shaders (TSL) evaluate (offset + T_hi) + T_lo, then the rotation, then the projection. The first sum is exact near the eye.
   - Objects with third-party materials (glTF) get a camera-relative `matrixWorld` composed in float64 and use three.js's default path. `highPrecision` stays off.
4. **Chunk-size rule.** A chunk drawn at distance d from the eye has radius R ≤ 1000·d. This keeps the worst case, with T_lo lost to a compiler, at or below about 0.4 px.
   - Geometry is refined where needed, independently of data.
   - Parent fallback draws ancestor data on child-sized geometry.
   - Data layers bucket features into grid cells (level 12–15, fixed in M10) and cut long lines and polygons at cell borders.
   - Per-vertex high/low attributes are not used.
5. **Morph.**
   - Globe and plane offsets are relative to each tile's own globe and plane centers (ADR 0008). Each tile carries two split offsets.
   - The blend is (1 − m)·a + m·b on eye-relative vectors, written out, never `mix` or a + m·(b − a).
   - Separate pipelines for m = 0, 0 < m < 1 and m = 1 are **required**, so street level never contains the globe term. This tightens ADR 0008, which made these variants conditional on GPU cost.
6. **Batching.** Per-draw offsets are plain records: two vec3, four with the morph. They are uniforms on WebGL2, and dynamic-offset uniforms or storage-buffer records indexed by draw on WebGPU (the osgEarth pattern), so batching is not blocked.
7. **Shaders that need the Earth** (atmosphere, horizon) receive the Earth center relative to the eye.

**Relation to `docs/plan/architecture.md` §3.** This ADR confirms float64 CPU math, RTC tiles, the float64 eye-relative transform and per-tile centers for the morph. It changes four things:

- it expresses the transform as a camera-relative world with a rotation-only view, so three.js world-space nodes are precise;
- it adds the split per-draw offset;
- it replaces per-vertex RTE for long primitives with spatial chunking;
- it adopts the 0.1 px threshold of F057/F078 instead of 0.5 px.

## Consequences

**Easier:**

- every three.js material, including instanced ones, is precise without flags;
- lighting, fog and shadows work in eye space;
- WebGPU and WebGL2 run identical arithmetic;
- CI on SwiftShader can validate precision, because no positions come from GPU trigonometry.

**Harder:**

- the engine owns `matrixWorld` and the per-draw offsets of every object each frame (automatic matrix updates are already off);
- data layers must chunk;
- the level-of-detail design must allow geometry refinement on ancestor data;
- `docs/plan/quality.md` and `architecture.md` should be updated to 0.1 px.

**Verification in M2.** Results are recorded in this ADR.

- **Vitest unit and property tests.** Emulate the shader arithmetic with `Math.fround` for random positions and eyes worldwide (poles, ±180°, ±85.05°, high and low elevations). Assert ≤ 0.01 px, and ≤ 0.4 px with T_lo dropped. Check the camera matrices against reference values (F047).
- **GPU readback test** on WebGPU, forced WebGL2 and SwiftShader. Tracked vertices write their clip position to an `rgba32float` target, which is compared with the float64 projection. The thresholds are the same as for the unit tests.
- **Reassociation canary.** Its result is recorded per device in the hardware matrix.
- **Scenario `street-level-jitter`.** 1 m altitude at about eight worldwide locations, residual ≤ 0.1 px on both backends (F057, F078). Morph sweep: m = 1 frames match the flat-only pipeline.
- **Benchmark.** The per-frame offset update for 5,000 draws takes ≤ 0.1 ms on the reference desktop, with zero allocations. The GPU frame-time difference of the split is within noise on the reference tablet.

## Update 2026-10-21

The M2 implementation first sent T as the translation of the float64 model-view matrix, which three.js rounds to float32 once at upload: T_lo was lost (KB-025). The renderer now follows point 3 as written:

- each frame `placeEyeRelative` splits T with `splitEyeOffset` and writes T_hi into the translation of the mesh's world matrix and T_lo into its bottom row, which an affine matrix leaves unused; both are float32 values, so three.js's float32 upload of the matrix keeps them exactly, and array stores allocate nothing (fields of an object such as `Vector3` box every double, ADR 0018);
- the shared vertex node (`eye-relative.ts`) reads them from the world matrix and evaluates `projection · view · ((offset + T_hi) + T_lo)`; the rest of the matrix stays the identity.

Verification done in M2: the property test of the Vitest bullet (`eye-offset.test.ts`, ≤ 0.01 px with the split and ≤ 0.4 px with T_lo dropped, plus a fixed case where dropping T_lo costs 0.13 px), and the street-level jitter scenario on both backends (F057). The GPU readback test and the reassociation canary are not built yet: their results matter per device, so they are listed in `docs/follow-ups.md` to join the hardware matrix run ([hardware testing](../guides/hardware-testing.md)).

## Update 2026-10-21 (GPU readback and canary)

The GPU readback test and the reassociation canary are built (`runGpuProbes` in `@vibeglobe/renderer`, `gpu-probes.ts`; playground `?experiment=gpu-probes`; `e2e/globe-gpu-probes.spec.ts`), on a renderer set up like the engine's and with the engine's vertex node, offset split and camera:

- **Readback.** 256 tracked vertices (the property test's distribution, generated deterministically, plus the KB-025 case) each write their clip position from `(offset + T_hi) + T_lo` to their own pixel of an `rgba32float` target, with flat interpolation; the read-back positions are compared with the float64 projection on a 4K screen. A second pass zeroes T_lo.
- **Canary.** The vertex node's sum with offset 0.5, T_hi = 2^24 and T_lo = −2^24, read back: 0 in float32 order, 0.5 if the compiler reassociated.
- **Results** on Chromium's SwiftShader, WebGPU and WebGL2 (both depth paths): maximum error 0.0004 px (limit 0.01), 0.15 px with T_lo dropped (limit 0.4) and 0.12 px on the KB-025 case (so the probe sees a lost T_lo), the canary in order. The end-to-end test prints the result, so the hardware run (`docs/guides/hardware-testing.md`) records it per device.

## Update 2026-10-21 (offset benchmark)

The benchmark of the verification list exists: `packages/renderer/src/eye-relative.test.ts` updates the split offsets of 5,000 draws per frame and requires zero allocations (a deliberately allocating change fails it), and `npm run bench:micro` times it against `quality/budgets.json` (`micro`, 0.1 ms median). On the cloud container's idle vCPU the median is 0.108 ms (p95 0.23–0.27 ms over three runs); the budget is for the reference desktop and is checked there by the hardware run (F075). Real frames update only the drawn tiles (about 20–800 in the M2 scenarios).
