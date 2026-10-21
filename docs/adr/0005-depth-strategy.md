# 0005. Depth strategy: one reversed-Z float encoding, with a fragment-depth path for WebGL2 without clip control

- Status: Accepted (partly superseded by 0013)
- Date: 2026-10-20
- Milestone: M2

## Context

One view can contain geometry 0.5 m from the eye and terrain or space thousands of kilometers away. The requirements:

- `PLAN.md` asks for no z-fighting between near and far geometry, and an M2 zoom from orbit to 1 m above the ground without z-fighting on both backends.
- F058 requires surfaces a few centimeters apart to resolve in the correct order from 0.5 m to the horizon, with no pixel alternating between frames, on WebGPU and on forced WebGL2.
- The same picture must appear in Chrome, Edge, Firefox and Safari, within the GPU budget of `docs/plan/quality.md`.

The [depth survey](../research/depth.md) studied CesiumJS, three.js r186, Babylon.js, Filament, Godot, osgEarth and iTowns, their issue trackers, and the WebGPU, WGSL and WebGL specifications. These findings drive the decision:

- **Platform asymmetry.**
  - WebGPU clips z to [0, w] and has core `depth32float`.
  - WebGL2 clips to [−w, w] unless `EXT_clip_control` is present, and its canvas depth is fixed-point. Float depth (`DEPTH_COMPONENT32F`) exists only in framebuffer objects.
  - `EXT_clip_control` is available in Chromium and WebKit but missing in Firefox in practice ([three.js #33166](https://github.com/mrdoob/three.js/issues/33166)).
- **Reversed-Z works only with both [0,1] clip and float storage.** A float32 emulation over 1 m to 10,000 km (survey §5) gives:
  - reversed-Z, infinite far, [0,1] clip, float32: about 1e-7·d (0.96 mm at 10 km), the limit of float32 view positions, and independent of near;
  - without clip control, or with 24-bit storage: no better than standard depth (tens of meters at 10 km with near = 0.1 m). Godot Compatibility, Babylon on WebGL and Filament on the web confirm this.
- **Logarithmic depth** gives about 1.2e-6·d (13 mm at 10 km). It writes fragment depth, which costs early-Z, hierarchical-Z and hidden-surface removal, and MSAA on surface intersections. It needs a finite far. It has to be injected into every shader, and missed shaders break (Babylon #13005, osgEarth #1663 and #2296). three.js maintainers recommend reversed depth instead and plan to deprecate log depth ([#29841](https://github.com/mrdoob/three.js/issues/29841)).
- **Multi-frustum rendering** (CesiumJS) keeps early-Z. In exchange it re-submits overlapping commands, leaves seams at frustum boundaries, and breaks every depth consumer: picking, voxels, translucency (Cesium #4381, #11014, #4368).
- **three.js r186.**
  - `reversedDepthBuffer` gives float depth automatically only for the WebGPU canvas depth and `PassNode`. Other render targets default to 24-bit ([#34803](https://github.com/mrdoob/three.js/pull/34803) changes that in r187).
  - On WebGL2 without `EXT_clip_control`, it warns and resets `renderer.reversedDepthBuffer` to false.
  - `logarithmicDepthBuffer` cannot be combined with reversed depth.
  - A material's own `depthNode` overrides the depth output.

[Architecture](../plan/architecture.md) §4 marks this decision "Proposed": reversed-Z with float32 depth where available, tight near/far fitted each frame, a log-depth fallback, and multi-frustum as an escape hatch.

## Options considered

1. **Standard depth with fitted near and far planes.**
   - Pros: no special API.
   - Cons:
     - With near = 0.1 m the error is 0.85 m at 1 km and 41 m at 10 km on WebGL2's 24-bit canvas, so F058 fails.
     - Raising near enough to help clips nearby geometry.
     - Fixed planes also fail: iTowns' 15 m near clips street views, and osgEarth's far plane clamped to the horizon tangent clips mountains beyond it.
2. **Reversed-Z, float32, infinite far, [0,1] clip (WebGPU; WebGL2 with `EXT_clip_control`).**
   - Pros:
     - Best precision, about 1e-7·d.
     - No shader changes and no fragment depth, so early-Z is intact.
     - No far plane to manage, and precision is independent of near (Filament ships this always on).
   - Cons:
     - Unavailable on WebGL2 without the extension (Firefox).
     - Every scene attachment must be float, never the canvas or a 24-bit default.
     - Depth-bias signs flip.
     - Code that assumes standard depth breaks (three.js #33570, and post nodes fixed in #34792).
3. **Logarithmic depth (fragment write) as the fallback, or everywhere.**
   - Pros: works on every path; mature in CesiumJS and three.js.
   - Cons:
     - About 10× coarser than option 2.
     - Needs a far plane.
     - Loses early-Z and MSAA on intersections ([#22017](https://github.com/mrdoob/three.js/issues/22017)).
     - Driver bugs ([#29841](https://github.com/mrdoob/three.js/issues/29841)).
     - Its stored value differs from option 2, so every depth consumer needs two decoders.
4. **Vertex-only logarithmic depth.**
   - Pros: keeps early-Z.
   - Cons: wrong between vertices, so large or near triangles get clipped (Cesium #6573, three.js #17384). A globe has coarse tiles near the camera at grazing angles.
5. **Multi-frustum rendering.**
   - Pros: keeps early-Z with any depth format.
   - Cons:
     - Each extra frustum re-submits overlapping draws.
     - Seams and translucency artifacts at boundaries.
     - Depth consumers and picking need per-frustum handling (Cesium #4381, #11014, #4368).
6. **Fragment-written reversed depth for WebGL2 without clip control.**
   - How: keep option 2's encoding, re-express the projection for [−1,1] clip space only so clipping stays correct, and write `near / viewDepth` (the perspective-correct `near · gl_FragCoord.w`) as fragment depth into `DEPTH_COMPONENT32F`.
   - Pros:
     - Precision equal to option 2 (survey §5: 1.8 mm at 10 km).
     - The same stored value, compare and clear as the main path.
     - No tessellation dependence and no far plane.
   - Cons: the same early-Z, MSAA and driver costs as option 3.

## Decision

Option 2 on WebGPU and on WebGL2 with `EXT_clip_control`. Option 6 on WebGL2 without it. Options 1, 3, 4 and 5 are rejected.

1. **One encoding on every path.**
   - The stored depth is `z = near / d`, where d is the view-space distance along the view axis (d = −z_view). Projection is reversed with an infinite far plane.
   - Depth is 32-bit float, cleared to 0, and tested with `greater-equal`.
   - Every consumer reconstructs `d = near / z`: fog, atmosphere, label occlusion, picking readback, post effects. No other depth encoding exists in the engine.
2. **Projection.**
   - The engine builds the projection in float64 next to the camera-relative view of [ADR 0004](0004-precision-strategy.md) and owns the three.js camera's projection matrix. three.js never recomputes it.
   - [0,1] clip: z_clip = near, w_clip = d. This is used on WebGPU and on WebGL2 after `clipControlEXT(LOWER_LEFT_EXT, ZERO_TO_ONE_EXT)`, which is set again after context restore.
   - [−1,1] clip on the fallback: z_clip = 2·near − d, w_clip = d. Clipping happens at d = near, with no far clip.
3. **Attachments.**
   - WebGPU uses `depth32float`, without stencil in the main scene pass.
   - WebGL2 uses a `DEPTH_COMPONENT32F` texture, or a multisampled renderbuffer of the same format resolved by blit. The scene never renders into the canvas depth.
   - With three.js r186, every scene render target gets an explicit `DepthTexture` with `FloatType`. `depth24plus`, `depth24plus-stencil8` and 24-bit WebGL formats are not allowed for scene depth.
   - Needing stencil in the main pass requires `depth32float-stencil8` (optional in WebGPU) or `DEPTH32F_STENCIL8`, recorded in a new ADR.
4. **Path selection.**
   - Create `WebGPURenderer({ reversedDepthBuffer: true })` and never set `logarithmicDepthBuffer`.
   - After `init()`, `renderer.reversedDepthBuffer === false` means WebGL2 without clip control. The engine then:
     - sets each scene material's `depthNode` to the fragment-written value;
     - sets `depthFunc` to `GreaterEqualDepth`;
     - uses the [−1,1] projection;
     - sets the clear depth to 0.
   - A debug option, also used by tests, forces the fallback by creating the renderer without `reversedDepthBuffer`. The debug overlay shows the active depth path.
5. **Planes.**
   - Far is infinite for depth. The CPU horizon distance, including maximum terrain height beyond the tangent point, is used only for culling.
   - Near is `min(0.1 m, 0.5 × camera clearance above the surface below)`, floored at 1 mm. The clearance is ellipsoid height until terrain exists (M4). Precision does not depend on near, so near is not fitted to scene bounds.
6. **Layering without depth bias.**
   - `polygonOffset` and `depthBias` are not used.
   - Draped data renders in the terrain pass (architecture §10).
   - Lines and markers that must sit above terrain get a view-space pull toward the eye proportional to distance, applied the same way on every path. Its factor is tuned in M10 and is well above the 1e-7·d resolution.
   - Passes that re-test the same surfaces compute positions with the identical shader path (Filament #293).

**Relation to architecture §4.** This ADR confirms reversed-Z with 32-bit float depth on WebGPU and on WebGL2 through `EXT_clip_control`. It changes three things:

- **The fallback becomes fragment-written reversed depth instead of logarithmic depth:** about 10× finer at the same cost, and one encoding instead of two.
- **Per-frame near/far fitting is replaced** by an infinite far and a near tied to camera clearance. Fitting adds work and clipping risk and gives nothing in precision.
- **Multi-frustum rendering is dropped from the plan.** If measurements ever require it, a new ADR supersedes this one.

## Consequences

- **Easier:**
  - Depth consumers, picking and tests use one formula on every backend.
  - No far plane to tune; no per-shader log-depth injection; early-Z on every WebGPU and Chromium or WebKit WebGL2 frame.
- **Harder:**
  - The engine owns projection matrices and depth attachments. Stock three.js features that read depth must be checked for reversed depth before use; post nodes are fixed only from r187 by #34792.
  - The fallback path loses early-Z, and MSAA anti-aliasing where surfaces intersect. Post-process anti-aliasing (M11) must cover that path.
  - WebGPU core cannot resolve multisampled depth, so depth consumers under MSAA need a single-sample depth (decided in the anti-aliasing and picking ADRs).
- **Follow-ups:**
  - The renderer ADR decides the three.js pin. r187 makes float depth the default and fixes the MSAA blit with reversed depth (#34926); explicit `FloatType` remains required either way.
  - Re-check Firefox `EXT_clip_control` each release.
  - If a WebGPU shader ever writes depth, use WGSL conservative `frag_depth` (`fragment_depth` language extension) when available.
- **Verification in M2:**
  - **Analytic unit test.** Emulate each path's arithmetic with `Math.fround`, and assert monotonic order and a resolvable step ≤ 3e-7·d (clip-control paths) and ≤ 5e-7·d (fallback) over [near, 4e7 m].
  - **Scenario `?scenario=depth-range` (F058).**
    - Camera 1 m above ground looking at the horizon.
    - Quad pairs 1, 2 and 5 cm apart from 0.5 m to 10 km, plus a draped line and a marker.
    - 120 static frames and 120 frames with sub-pixel jitter, checking order colors and frame differencing for oscillating pixels.
    - Runs on WebGPU, forced WebGL2 with clip control, forced fallback in Chrome, and Firefox.
  - **Depth-readback reconstruction** within 1e-6·d of the analytic surface on every path.
  - **GPU timing.**
    - Use timestamp queries in a tilted high-overdraw terrain view at 1080p, on the reference desktop and tablet.
    - The fallback path may cost at most 1.25× the clip-control path on the same device.
    - If it costs more, the measurement goes into a new ADR, which evaluates a two-frustum split for that path only.

## Update 2026-10-21

The first M2 renderer used three.js's default scene depth, which is 24-bit (KB-024), and had no fragment path. Now:

- **Attachments.** The renderer's framebuffer target gets a `DepthTexture` of `FloatType` (`depth.ts`). three.js 0.186 still allocates the multisampled WebGL2 depth renderbuffer as `DEPTH_COMPONENT24` for a float depth texture (it compares `FloatType` with `gl.FLOAT`), which also breaks the resolve blit; `useFloatMultisampledDepth` (`webgl-compat.ts`) allocates `DEPTH_COMPONENT32F` instead. `RendererCapabilities.depthFormat` reports the format actually allocated (the renderbuffer's on WebGL2), and the end-to-end tests require `depth32float` on every path.
- **Fragment path.** When `renderer.reversedDepthBuffer` is false after `init()`, the shared vertex node also sets `depthNode = near / d` (d interpolated as a varying) and `depthFunc = GreaterEqualDepth`, the clear depth is 0 and the projection's elements 10 and 14 become 1 and 2·near. The renderer option `depth: 'fragment'` (playground `?depth=fragment`) forces it on WebGL2; WebGPU always uses hardware reversed-Z. F058 runs on all three paths.
- **Diagnostics.** `RendererCapabilities.depthPath` is `'reversed-z'` or `'fragment'`; the debug overlay shows the path and the format.
- **Analytic test.** `depth.test.ts` emulates both paths in float32 (steps of 3e-7·d and 5e-7·d resolve from 1 mm to 4e7 m) and shows the fixed-function [−1, 1] mapping does not, which is why the fragment write exists.

The depth-readback reconstruction and the GPU timing comparison of the two paths are not built yet: the timing needs the reference devices, so both are listed in `docs/follow-ups.md` to join the hardware matrix run ([hardware testing](../guides/hardware-testing.md)).

## Update 2026-10-21 (depth readback)

The depth-readback reconstruction is built (`runGpuProbes`, `e2e/globe-gpu-probes.spec.ts`): 64 planes facing the camera at log-spaced view distances from 0.12 m to 4e7 m, drawn with the engine's material into a target with a 32-bit float depth texture, whose depth a second pass copies into an `rgba32float` target. Every plane's d = near / z is within 1.5e-7·d on WebGPU and WebGL2 with clip control and within 2.3e-7·d on the fragment path (limit 1e-6·d), on Chromium's SwiftShader. The GPU timing comparison of the two paths needs timestamp queries on the reference devices: `npm run bench` records the GPU frame time where the browser offers it, with a `drag-400-webgl2-fragment` scenario next to `drag-400-webgl2` for the 1.25× rule. In the cloud container on SwiftShader the GPU p95 of `drag-400-webgl2-fragment` is 1339 ms against 961 ms for `drag-400-webgl2` (1.39×), but SwiftShader rasterizes on the CPU and its timings say nothing about a hardware GPU, so the 1.25× rule is decided only on the reference devices (F075).
