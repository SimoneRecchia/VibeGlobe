# Floating-point precision (vertex jitter)

Survey for milestone M1. The decision is in [ADR 0004](../adr/0004-precision-strategy.md), which milestone M2 builds.

## 1. Scope and requirements

This survey covers how to render positions on a WGS84 Earth with 32-bit GPU floats without vertex jitter, from orbit down to 1 m above the ground. It covers the globe, the flat map, the globe-to-flat morph, and the camera matrices. Depth precision (z-fighting) is covered in a separate survey.

Requirements from `PLAN.md` and `feature_list.json`:

- **Rendering and visual quality:** "no vertex jitter at street level despite 32-bit GPU floats".
- **Performance and quality targets:** "Vertex jitter at street level: None visible".
- **M2 done-when:** zooming from orbit to about 1 m above the ground shows no jitter, on both backends.
- **F057 / F078:** the residual screen-space motion of tracked vertices, beyond what the camera motion explains, stays below **0.1 px** on WebGPU and on forced WebGL2. Note that `docs/plan/quality.md` and `docs/plan/architecture.md` say 0.5 px. The stricter feature-list value governs (see §9).
- **F047:** the camera keeps its position in double precision.
- **F136 (terrain), F367 (data primitives), F464 (3D Tiles), F497 (release check):** terrain, primitives and 3D Tiles must also be jitter-free.
- **Map experience:** the globe-to-flat morph interpolates ellipsoid and plane positions on the GPU.
- **Fixed constraints:** WebGPU first with a WebGL2 fallback, three.js `WebGPURenderer` as the recommended base, WGS84 everywhere.

### The size of the problem

| Quantity                                                             | Value                              |
| -------------------------------------------------------------------- | ---------------------------------- |
| float32 unit roundoff `u`                                            | 2⁻²⁴ ≈ 6.0·10⁻⁸                    |
| float32 spacing at ECEF magnitudes (4.2–8.4·10⁶ m)                   | 0.5 m                              |
| float32 spacing at Web Mercator magnitudes (up to 2.0·10⁷ m)         | 2 m                                |
| Focal length `f` (1080 px tall viewport, 60° vertical field of view) | ≈ 935 px; this survey uses 1000 px |
| 0.1 px at a distance of 1 m                                          | 0.1 mm                             |

Screen error is `e_px ≈ ε · f / d`, where `ε` is the position error and `d` the distance from the eye.

The target (0.1 mm against a 6.4·10⁶ m radius) needs about 1.6·10⁻¹¹ relative precision. That is about 4,000 times finer than float32. Positions must therefore reach the GPU as small, eye-relative numbers. The only question is how to get them there.

## 2. Projects studied

| Project                       | Version (commit)                                                                                                      | License        | Files and modules read                                                                                                                                                                                                                                                                                      |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CesiumJS                      | [1.146](https://github.com/CesiumGS/cesium/tree/1.146) (`b8d3a36`)                                                    | Apache-2.0     | `packages/core/Source/EncodedCartesian3.js`, `engine/Source/Renderer/UniformState.js`, `Shaders/Builtin/Functions/{translateRelativeToEye,computePosition,columbusViewMorph}.glsl`, `Scene/GlobeSurfaceTileProvider.js`, `Shaders/GlobeVS.glsl`, `Scene/Primitive.js`, `Scene/PolylineCollection.js`, Specs |
| deck.gl                       | [v9.4.0](https://github.com/visgl/deck.gl/tree/v9.4.0) (`5eded84`)                                                    | MIT            | `modules/core/src/shaderlib/project/*`, `viewports/viewport.ts`, `modules/extensions/src/fp64/*`, `docs/developer-guide/{coordinate-systems,fp64}.md`, `dev-docs/RFCs/v6.1/improved-lnglat-projection-rfc.md`, tests                                                                                        |
| luma.gl (deck.gl's GPU layer) | [v9.4.2](https://github.com/visgl/luma.gl/tree/v9.4.2) (`94e95a6`)                                                    | MIT            | `modules/shadertools/src/modules/math/fp64/*`, `lib/shader-assembly/platform-defines.ts`, `lib/shader-assembler.ts`, fp64 tests                                                                                                                                                                             |
| iTowns                        | [v2.46.0](https://github.com/iTowns/itowns/tree/v2.46.0) (`b538924`)                                                  | CeCILL-B / MIT | `packages/Main/src/Core/Prefab/{TileBuilder.ts,Globe/GlobeTileBuilder.ts}`, `Converter/convertToTile.js`, `Renderer/Shader/TileVS.glsl`                                                                                                                                                                     |
| OpenGlobus                    | main [`d2bdd88`](https://github.com/openglobus/openglobus/tree/d2bdd88ccf826d1106d279d1393f8457061d4eb2) (1.0.0-rc33) | Apache-2.0     | `src/math/{coder,Vec3}.ts`, `src/camera/Camera.ts`, `src/segment/Segment.ts`, `src/quadTree/Node.ts`, `src/shaders/segment/*`, `src/entity/strip/StripHandler.ts`                                                                                                                                           |
| 3DTilesRendererJS             | [v0.5.3](https://github.com/NASA-AMMOS/3DTilesRendererJS/tree/v0.5.3) (`476ed6b`)                                     | Apache-2.0     | `src/three/renderer/loaders/B3DMLoader.js`, `src/three/plugins/{ReorientationPlugin.js,batched/ModelViewBatchedMesh.js}`, `renderer/controls/GlobeControls.js`                                                                                                                                              |
| MapLibre GL JS                | [v6.15.0](https://github.com/maplibre/maplibre-gl-js/tree/v6.15.0) (`638b3f9`)                                        | BSD-3-Clause   | `src/geo/projection/{mercator_transform,vertical_perspective_transform,globe_transform,projection_factory}.ts`, `src/shaders/glsl/_projection_globe.vertex.glsl`, tests, benchmarks                                                                                                                         |
| osgEarth                      | [osgearth-3.8.1](https://github.com/gwaldron/osgearth/tree/osgearth-3.8.1) (`a656f46`)                                | MIT            | `src/osgEarthDrivers/engine_rex/{SurfaceNode,TerrainCuller,LayerDrawable}.cpp`, `RexEngine.GL4.glsl`, `RexEngine.vert.GL4.glsl`, `src/applications/osgearth_tests`                                                                                                                                          |
| three.js (rendering base)     | [r186](https://github.com/mrdoob/three.js/tree/r186) (`9b4a2ac`)                                                      | MIT            | `src/nodes/accessors/{ModelNode,Position}.js`, `src/renderers/common/Renderer.js`, `src/renderers/WebGLRenderer.js`                                                                                                                                                                                         |
| WGSL specification            | gpuweb `main`, October 2026                                                                                           | W3C            | [Reassociation and fusion](https://www.w3.org/TR/WGSL/#reassociation-and-fusion), [floating-point accuracy](https://www.w3.org/TR/WGSL/#floating-point-accuracy)                                                                                                                                            |

## 3. How each project solves it

### CesiumJS

CesiumJS uses two techniques side by side.

**Globe tiles use relative-to-center rendering (RTC).**

- Terrain vertices are stored relative to `mesh.center`. They may also be quantized to 12 bits and decoded by a scale-and-bias matrix ([GlobeVS.glsl](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Shaders/GlobeVS.glsl)).
- For each tile, the CPU transforms the center by the view matrix in float64. It writes the result into the translation of `u_modifiedModelView` and `u_modifiedModelViewProjection` ([GlobeSurfaceTileProvider.js](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Scene/GlobeSurfaceTileProvider.js)). The GPU therefore never sees the large center coordinate.
- In 2D and Columbus view, the 2D position is computed in the shader from texture coordinates and an RTC tile rectangle. Above level 11 the Mercator Y is linear. At lower levels it uses a Mercator formula.
- While morphing, RTC is switched off. A comment in the shader acknowledges that this can cause jitter and judges it unlikely to be noticed.

**Primitives, polylines and billboards use GPU relative-to-eye rendering (RTE).**

- `EncodedCartesian3` ([source](https://github.com/CesiumGS/cesium/blob/1.146/packages/core/Source/EncodedCartesian3.js)) splits each double into `high = floor(v/65536)·65536` and `low = v − high`.
- [UniformState.js](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Renderer/UniformState.js) uploads the camera split the same way (`czm_encodedCameraPositionMCHigh/Low`). It also uploads a model-view matrix with its translation zeroed (`czm_modelViewRelativeToEye`).
- `czm_translateRelativeToEye` ([shader](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Shaders/Builtin/Functions/translateRelativeToEye.glsl)) subtracts high from high and low from low. It also contains a guard that zeroes the high difference, added for NaNs seen on iOS.
- The high parts are multiples of 65536, so their difference is exact. The low part in [0, 65536) is only stored to float32 spacing of 2⁻⁸ m. **The eye-relative position is therefore quantized to about 4 mm**. That is invisible at 100 m but several pixels at 1 m.
- [Primitive.js](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Scene/Primitive.js) generates `czm_computePosition` with branches on `czm_morphTime`: 3D only, 2D only, or `czm_columbusViewMorph` of both RTE positions. **Morphable geometry therefore carries four vec3 per position** (3D high/low, 2D high/low).
- [PolylineCollection.js](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Scene/PolylineCollection.js) carries these four vec3 for the previous, current and next point. That is 13 vertex attributes, against a minimum of 16 in both WebGL2 and WebGPU.
- Primitive RTC (`rtcCenter`) exists only for 3D-only scenes with a single geometry instance.
- [columbusViewMorph.glsl](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Shaders/Builtin/Functions/columbusViewMorph.glsl) avoids `mix`. Its comment explains that on GeForce 3070 Ti and Intel Arc A750, `mix` is not exact at t = 0 or t = 1, which produces jitter.
- Models and 3D Tiles use `RTC_CENTER` / `CESIUM_RTC`. Their model-view is composed on the CPU in float64.

### deck.gl and luma.gl

deck.gl has three generations of technique.

**1. Emulated 64-bit (`Fp64Extension`).**

- [project64.glsl.ts](https://github.com/visgl/deck.gl/blob/v9.4.0/modules/extensions/src/fp64/project64.glsl.ts) runs the whole Mercator projection and the view-projection product in double-float (`vec2` per scalar) arithmetic.
- The arithmetic comes from luma.gl ([fp64-arithmetic-glsl.ts](https://github.com/visgl/luma.gl/blob/v9.4.2/modules/shadertools/src/modules/math/fp64/fp64-arithmetic-glsl.ts)).
- It is now marked deprecated. The docs ([fp64.md](https://github.com/visgl/deck.gl/blob/v9.4.0/docs/developer-guide/fp64.md)) and the [v6.1 RFC](https://github.com/visgl/deck.gl/blob/v9.4.0/dev-docs/RFCs/v6.1/improved-lnglat-projection-rfc.md) report about 10× shader cost, slow compilation on Windows, and the need for per-driver workarounds.

**2. Offset coordinate systems** (`meter-offsets`, `lnglat-offsets`).

- The application supplies a `coordinateOrigin`. Offsets go through a linearized local projection: a first-order factor plus a second-order term in dy.

**3. Automatic offset mode, the default since v6.1.**

- `Viewport.projectionMode` ([viewport.ts](https://github.com/visgl/deck.gl/blob/v9.4.0/modules/core/src/viewports/viewport.ts)) switches to `WEB_MERCATOR_AUTO_OFFSET` at zoom ≥ 12.
- [viewport-uniforms.ts](https://github.com/visgl/deck.gl/blob/v9.4.0/modules/core/src/shaderlib/project/viewport-uniforms.ts) sets the shader origin to the viewport center rounded to float32 (`Math.fround`). It projects that origin in float64 on the CPU and folds it into a `projectionCenter` uniform.
- Positions are uploaded as float32 plus a `positions64Low` residual (x − fround(x)).
- [project.glsl.ts](https://github.com/visgl/deck.gl/blob/v9.4.0/modules/core/src/shaderlib/project/project.glsl.ts) subtracts the float32 origin from the high part, which is exact near the center. It then applies the linearized projection to the difference and adds the projected low part. Beyond 0.25° from the origin it falls back to the high part only.
- **`GLOBE` mode disables offset mode.** Positions are computed with shader `sin`/`cos` on a 256-unit sphere. Its precision is about u·R ≈ 0.4 m plus trig error, which is why deck.gl switches to `WebMercatorViewport` above zoom 12.

**luma.gl fp64.**

- The GLSL path multiplies by a runtime uniform `ONE` so that compilers cannot cancel the error terms. [platform-defines.ts](https://github.com/visgl/luma.gl/blob/v9.4.2/modules/shadertools/src/lib/shader-assembly/platform-defines.ts) enables this per vendor (Apple, NVIDIA, Intel and unknown). It also enables an "imprecise tan" workaround.
- On WebGPU with Apple GPUs, [shader-assembler.ts](https://github.com/visgl/luma.gl/blob/v9.4.2/modules/shadertools/src/lib/shader-assembler.ts) switches to an integer implementation ([fp64-arithmetic-wgsl-integer.ts](https://github.com/visgl/luma.gl/blob/v9.4.2/modules/shadertools/src/modules/math/fp64/fp64-arithmetic-wgsl-integer.ts)). The reason given in the source: Metal may reorder the floating-point steps that classic double-single arithmetic depends on.

### iTowns

iTowns is built on three.js `WebGLRenderer` and relies on its CPU-side float64 model-view.

- Tile geometry is built around the tile center. Tiles on the same latitude band share one buffer ([TileBuilder.ts](https://github.com/iTowns/itowns/blob/v2.46.0/packages/Main/src/Core/Prefab/TileBuilder.ts)).
- Each tile mesh gets the band's rigid transform as `position` plus `quaternion` ([GlobeTileBuilder.ts](https://github.com/iTowns/itowns/blob/v2.46.0/packages/Main/src/Core/Prefab/Globe/GlobeTileBuilder.ts)). That transform is made relative to the parent tile ([convertToTile.js](https://github.com/iTowns/itowns/blob/v2.46.0/packages/Main/src/Converter/convertToTile.js)).
- three.js multiplies `camera.matrixWorldInverse · object.matrixWorld` in JavaScript doubles, so the uploaded model-view has a small translation.
- [TileVS.glsl](https://github.com/iTowns/itowns/blob/v2.46.0/packages/Main/src/Renderer/Shader/TileVS.glsl) uses three's standard `project_vertex` chunk. It uses `modelMatrix` only for normals.
- Other geometry (features, point clouds) is placed in local frames by the application. The maintainers' answer to jitter reports is "the data must be moved in a local system" (issue #2023).

### OpenGlobus

OpenGlobus started with Cesium-style RTE and added RTC per terrain segment in 2026 (issue #963).

- [coder.ts](https://github.com/openglobus/openglobus/blob/d2bdd88ccf826d1106d279d1393f8457061d4eb2/src/math/coder.ts) and `Vec3.doubleToTwoFloats` use the same 65536 split as Cesium.
- [Camera.ts](https://github.com/openglobus/openglobus/blob/d2bdd88ccf826d1106d279d1393f8457061d4eb2/src/camera/Camera.ts) uploads `eyeHigh`/`eyeLow` and a rotation-only `_viewMatrixRTE`.
- [Segment.ts](https://github.com/openglobus/openglobus/blob/d2bdd88ccf826d1106d279d1393f8457061d4eb2/src/segment/Segment.ts) stores terrain vertices relative to `_relativeCenter`, which is the bounding-sphere center ([Node.ts](https://github.com/openglobus/openglobus/blob/d2bdd88ccf826d1106d279d1393f8457061d4eb2/src/quadTree/Node.ts)). It still splits them into high/low.
- Each frame, the segment computes `eye − _relativeCenter` in float64 and uploads it split (`rtcEyePositionHigh/Low`).
- The vertex shader ([segment_screen_wl.vert.glsl](https://github.com/openglobus/openglobus/blob/d2bdd88ccf826d1106d279d1393f8457061d4eb2/src/shaders/segment/segment_screen_wl.vert.glsl)) forms the high and low differences. It zeroes a high difference shorter than 1 m (a guard similar to Cesium's) and applies the rotation-only view.
- Because the eye offset is relative to a nearby center, the 4 mm quantization of the 65536 split mostly disappears for the segments under the camera.
- Polylines and strips use one `_relativeCenter` per handler ([StripHandler.ts](https://github.com/openglobus/openglobus/blob/d2bdd88ccf826d1106d279d1393f8457061d4eb2/src/entity/strip/StripHandler.ts)).

### 3DTilesRendererJS

3DTilesRendererJS relies on three.js and on 3D Tiles content being RTC.

- `RTC_CENTER` goes into the glTF scene's `position` ([B3DMLoader.js](https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/v0.5.3/src/three/renderer/loaders/B3DMLoader.js)), so the float64 model-view keeps vertices small.
- The `ReorientationPlugin` moves the tileset so a chosen latitude/longitude sits at the scene origin. This keeps world-space shader math (lighting, fog, shadows) small near that point.
- [ModelViewBatchedMesh.js](https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/v0.5.3/src/three/plugins/batched/ModelViewBatchedMesh.js) handles three's `BatchedMesh`, whose per-instance matrices live in a float32 texture.
  - It keeps the float64 instance matrices.
  - It re-expresses them in the camera frame of a reference pose.
  - It re-bases only when the camera has moved more than 10 km (`resetDistance`).
  - Between re-bases the uploaded data is constant. Jitter becomes a rare sub-millimetre jump.
- [GlobeControls.js](https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/v0.5.3/src/three/renderer/controls/GlobeControls.js) moves the camera exactly along its forward vector, so that rounding error does not shift it sideways. Camera control math has precision hazards of its own.

### MapLibre GL JS

**Mercator path.**

- Tile geometry is in integer tile coordinates (extent 8192), uploaded as `Int16`.
- `calculatePosMatrix` ([mercator_transform.ts](https://github.com/maplibre/maplibre-gl-js/blob/v6.15.0/src/geo/projection/mercator_transform.ts)) builds the tile-to-clip matrix in `Float64Array` and converts it to `Float32Array` once, cached per tile and per frame.
- This is RTC with quantized local coordinates. Its precision does not depend on the absolute position. Wrapped copies of the world are separate tile IDs with their own matrices.

**Globe path.**

- `vertical_perspective_transform.ts` builds a single float64 matrix for a unit sphere. It converts the matrix to float32 once ([source](https://github.com/maplibre/maplibre-gl-js/blob/v6.15.0/src/geo/projection/vertical_perspective_transform.ts)).
- The shader maps tile coordinates to the sphere ([_projection_globe.vertex.glsl](https://github.com/maplibre/maplibre-gl-js/blob/v6.15.0/src/shaders/glsl/_projection_globe.vertex.glsl)). Since 2026 it does this without `atan`/`sin`/`cos` for latitude: it uses exp plus half-angle identities, because Mali and Intel trig was hundreds of metres off (issue #7419).
- Unit-sphere float32 coordinates give about u·R ≈ 0.4 m. That is why the `globe` preset interpolates from `vertical-perspective` at zoom 11 to `mercator` at zoom 12 ([projection_factory.ts](https://github.com/maplibre/maplibre-gl-js/blob/v6.15.0/src/geo/projection/projection_factory.ts)). Street level is always on the per-tile Mercator path.

**Morph.**

- `interpolateProjection` mixes the _clip-space_ results of the two paths (globe matrix · sphere position, fallback Mercator matrix · tile position), with special handling of z.
- Each projection keeps its own precision-friendly path. No common world frame is needed.
- At `u_projection_transition > 0.999` only the globe term is evaluated. [globe_transform.ts](https://github.com/maplibre/maplibre-gl-js/blob/v6.15.0/src/geo/projection/globe_transform.ts) switches entirely to the Mercator transform when `globeness` reaches 0.

### osgEarth

**OpenSceneGraph matrices.**

- Matrices are double by default. The cull traversal accumulates each node's model-view in double and converts it to float only at upload.

**REX terrain engine.**

- Each tile's `SurfaceNode` is a `MatrixTransform` holding a local-to-world ENU frame at the tile centroid ([SurfaceNode.cpp](https://github.com/gwaldron/osgearth/blob/osgearth-3.8.1/src/osgEarthDrivers/engine_rex/SurfaceNode.cpp)).
- [TerrainCuller.cpp](https://github.com/gwaldron/osgearth/blob/osgearth-3.8.1/src/osgEarthDrivers/engine_rex/TerrainCuller.cpp) captures the double model-view per tile.
- [LayerDrawable.cpp](https://github.com/gwaldron/osgearth/blob/osgearth-3.8.1/src/osgEarthDrivers/engine_rex/LayerDrawable.cpp) packs it as a float `mat4` into a per-tile storage-buffer record (`oe_rex_Tile.modelViewMatrix` in [RexEngine.GL4.glsl](https://github.com/gwaldron/osgearth/blob/osgearth-3.8.1/src/osgEarthDrivers/engine_rex/RexEngine.GL4.glsl)). The shader indexes it by tile ID, so all tiles draw in a few multi-draw calls.
- This is the batching-friendly form of RTC.
- Level-of-detail geomorphing mixes two tile-local positions (`a_position`, `a_neighbor`), which is precision-safe.
- Geocentric and projected maps are separate modes. There is no globe-to-flat morph.
- Applications position models with `GeoTransform`, which creates a local frame.

### three.js r186 (the recommended base): the critical pitfall

- `WebGLRenderer` computes `object.modelViewMatrix` on the CPU in doubles for every object ([WebGLRenderer.js](https://github.com/mrdoob/three.js/blob/r186/src/renderers/WebGLRenderer.js)).
- **`WebGPURenderer` does not do this by default.**
  - In [ModelNode.js](https://github.com/mrdoob/three.js/blob/r186/src/nodes/accessors/ModelNode.js), `modelViewMatrix` resolves to `mediumpModelViewMatrix = cameraViewMatrix · modelWorldMatrix`, a float32 product on the GPU.
  - With absolute ECEF in `matrixWorld` this cancels two 6·10⁶ m translations in float32, giving 0.5 m snapping.
  - The opt-in is `renderer.highPrecision = true` ([Renderer.js](https://github.com/mrdoob/three.js/blob/r186/src/renderers/common/Renderer.js)), which uses `highpModelViewMatrix` computed on the CPU. It is documented as incompatible with `InstancedMesh` and `SkinnedMesh`.
- `positionWorld` ([Position.js](https://github.com/mrdoob/three.js/blob/r186/src/nodes/accessors/Position.js)) is `modelWorldMatrix · positionLocal` in float32. Any built-in node that uses world space (fog, lights, shadows, environment) is imprecise unless the world itself is camera-relative.

## 4. Known failure modes from issue trackers

| Issue                                                                                            | Symptom                                                                                                                  | Root cause                                                                                                                                                                                                                          | Lesson                                                                                                                      |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [CesiumGS/cesium#9417](https://github.com/CesiumGS/cesium/issues/9417)                           | Tracked entities' paths jagged and jittery on iOS and M1 Macs                                                            | Shader compiler over-optimizing `czm_translateRelativeToEye` (WebKit bug 237434). Workarounds were `invariant gl_Position` or perturbing the low term. Closed in 2024 when a later release no longer showed it, without a named fix | GPU RTE arithmetic is not safe from compiler rewriting. Prefer designs whose worst case under rewriting is still acceptable |
| [CesiumGS/cesium#11603](https://github.com/CesiumGS/cesium/issues/11603)                         | High-precision polylines zig-zag on ARM64 Macs (Safari, Chrome, Firefox)                                                 | Same as #9417 (closed as a duplicate)                                                                                                                                                                                               | Apple GPUs need their own entry in the test matrix                                                                          |
| [CesiumGS/cesium#11801](https://github.com/CesiumGS/cesium/issues/11801)                         | Labels "jitter violently" with the camera very close (M1/M2)                                                             | Same family as #9417                                                                                                                                                                                                                | Billboards and labels share the position path. Test them at street level too                                                |
| [CesiumGS/cesium#12879](https://github.com/CesiumGS/cesium/issues/12879)                         | Straight polylines render as jittery zig-zags on Intel Arc (ANGLE D3D)                                                   | Driver flattened the `czm_morphTime` branches into a single `czm_columbusViewMorph`, whose blend of far-apart 2D and 3D positions is imprecise at t = 1. Fixed by #13107                                                            | Never blend two distant absolute positions. Do not rely on runtime branches for the morph endpoints. Use separate pipelines |
| [CesiumGS/cesium#11657](https://github.com/CesiumGS/cesium/issues/11657)                         | Lines and small models shake when the camera is very close (Windows, still open)                                         | Maintainer: "precision issues". Consistent with the about-4 mm quantization of the 65536 split                                                                                                                                      | The 65536 split is not enough for 1 m camera distances                                                                      |
| [CesiumGS/cesium#7100](https://github.com/CesiumGS/cesium/issues/7100)                           | Vertices displaced on iOS (distorted boxes, missing lines)                                                               | Invalid high differences on iOS GPUs. Led to the zero-length guard in `translateRelativeToEye`. Resolved by #11788                                                                                                                  | Mobile GPUs add failure modes that desktop testing misses                                                                   |
| [CesiumGS/cesium#12061](https://github.com/CesiumGS/cesium/issues/12061)                         | Voxel cells merge at fine levels of detail                                                                               | Ray marching in shape-wide coordinates exceeded float32. Fixed (#12933) by marching relative to the eye                                                                                                                             | Every shader space, not only vertex positions, must be eye-relative                                                         |
| [visgl/deck.gl#8235](https://github.com/visgl/deck.gl/issues/8235)                               | Stair-stepping, misaligned geometry on iOS 17 / macOS 14 (Chrome and Safari via Metal)                                   | Compiler or statement-order sensitivity in precision code. `invariant gl_Position` helped. Fixed by #8454                                                                                                                           | Precision code is sensitive to statement order. A backend change (to Metal) can break it                                    |
| [visgl/deck.gl#10804](https://github.com/visgl/deck.gl/issues/10804)                             | `GlobeView` points hundreds of metres off under SwiftShader                                                              | Software `sin`/`cos` errors of 4·10⁻⁵ to 1.9·10⁻⁴; "an error of 1e-4 … moves a point by about 640 m"                                                                                                                                | CI on SwiftShader cannot validate trig-based positions. Never derive absolute positions from GPU trig                       |
| [visgl/luma.gl#1764](https://github.com/visgl/luma.gl/issues/1764)                               | fp64 emulation silently degrades to fp32 on Apple M1/M2                                                                  | Compiler removes the error-compensation steps. Fixed only in v10 with substantial changes                                                                                                                                           | Emulated double precision depends on the compiler, and failures are silent                                                  |
| [visgl/luma.gl#3425](https://github.com/visgl/luma.gl/issues/3425)                               | Precise WGSL projection shaders time out compiling (more than 180 s) on D3D12. Vulkan driver drops error-free transforms | Full inlining in D3D bytecode. Vulkan optimizer cancels the low limb. Fixed by #3426 (October 2026)                                                                                                                                 | Emulated fp64 on WebGPU costs compile time and needs per-backend arithmetic paths                                           |
| [maplibre/maplibre-gl-js#4871](https://github.com/maplibre/maplibre-gl-js/issues/4871)           | Custom-layer geometry jumps at high zoom, while tiles are smooth                                                         | Global Mercator coordinates in float32 ("floats have a limit on precision that is around 5 meters"). Tiles are fine because they are tile-relative                                                                                  | Everything drawn at street level needs a local origin, including application data                                           |
| [maplibre/maplibre-gl-js#7419](https://github.com/maplibre/maplibre-gl-js/issues/7419)           | On Mali GPUs, distinct latitudes overlap in globe view near zoom 11                                                      | `sin`/`cos` errors of 200–300 m (Mali, Intel UHD). Mali `sin` is not monotonic. Fixed by #7916 with algebraic identities                                                                                                            | GPU trig accuracy varies by vendor. Compute positions on the CPU                                                            |
| [mrdoob/three.js#30955](https://github.com/mrdoob/three.js/issues/30955)                         | `WebGPURenderer` transforms "broken at large scales". Same scene fine in `WebGLRenderer`                                 | Model × view computed on the GPU in float32 (the CPU path was removed for performance). Fixed by #30970 (opt-in high precision)                                                                                                     | The base renderer's default is unsafe for globe coordinates                                                                 |
| [NASA-AMMOS/3DTilesRendererJS#1245](https://github.com/NASA-AMMOS/3DTilesRendererJS/issues/1245) | Each tile snaps to rounded positions while panning with `WebGPURenderer`                                                 | Same as three.js#30955. Fixed by `highPrecision = true`. "There's no way to handle this automatically"                                                                                                                              | Make camera-relative transforms the engine's design, not a renderer flag                                                    |
| [iTowns/itowns#2023](https://github.com/iTowns/itowns/issues/2023)                               | three.js `Line` objects jiggle while the camera moves                                                                    | "The vertex position are too big". Fixed by moving data into a local system                                                                                                                                                         | Data layers must use local origins                                                                                          |
| [openglobus/openglobus#963](https://github.com/openglobus/openglobus/issues/963)                 | Feature: RTC for the segment under the camera (done in May 2026)                                                         | Pure RTE was not precise enough under the camera                                                                                                                                                                                    | Mature engines converge on RTC near the camera                                                                              |
| [gwaldron/osgearth#2283](https://github.com/gwaldron/osgearth/issues/2283)                       | Large triangle fragmented. Maintainer: lat/long to ECEF "in a 32-bit shader … usually vertex jittering"                  | Geodetic-to-ECEF conversion in a float32 shader                                                                                                                                                                                     | Do geodesy on the CPU in float64                                                                                            |
| [gwaldron/osgearth#181](https://github.com/gwaldron/osgearth/issues/181)                         | Bad double-click zoom on Mercator maps                                                                                   | Single-precision intersector. Switched to the double-precision one                                                                                                                                                                  | Picking and camera math need float64 too                                                                                    |

## 5. How they test and benchmark precision

- **CesiumJS:** Jasmine/Karma specs. `EncodedCartesian3Spec` tests encoding on the CPU. `BuiltinFunctionsSpec` and `AutomaticUniformSpec` render one pixel whose fragment shader checks `czm_translateRelativeToEye` and the RTE matrices for exact equality. They use small values (for example a point at (6,5,4)), so Earth-scale cancellation is not tested. There are no automated jitter or render-precision tests. Precision is checked manually in Sandcastle, and performance with a manual guide.
- **deck.gl:** [project-32-64-glsl.spec.ts](https://github.com/visgl/deck.gl/blob/v9.4.0/test/modules/core/shaderlib/project/project-32-64-glsl.spec.ts) runs the projection shader through transform feedback. It compares the result with the float64 JavaScript projection within 0.001 px at zoom 10 and zoom 16 (pitched). It runs on WebGL only. Golden-image render tests include "high-precision" cases at zoom 22 (for example `heatmap-layer.spec.ts`).
- **luma.gl:** fp64 arithmetic tests run on the GPU (transform feedback on WebGL, compute shaders on WebGPU). They use adversarial inputs (half-ULP ties, wide exponent pairs) against JavaScript doubles, across arithmetic paths ([fp64-arithmetic-compute.spec.ts](https://github.com/visgl/luma.gl/blob/v9.4.2/modules/shadertools/test/modules/math/fp64-arithmetic-compute.spec.ts)). Projection-performance specs measured pipeline-creation time per backend (#3425).
- **MapLibre GL JS:** Vitest unit tests of the float64 transforms, to 10 digits (`globe_transform.test.ts`, `mercator_transform.test.ts`). Render tests compare against expected images, including `projection/globe/zoom-transition`. Benchmarks such as `transform_hot_paths.bench.ts` and `mercator_transform.bench.ts` cover the hot paths. The Mali trig bug was found in the field, not by tests.
- **iTowns:** Mocha unit tests on the CPU (`packages/Main/test/unit`) and Puppeteer functional tests of the examples (`test/functional`). No precision-specific tests.
- **OpenGlobus:** Vitest unit tests with mocked WebGL. `Strip.test.js` checks the high/low arrays. No GPU tests.
- **3DTilesRendererJS:** Jest unit tests on the CPU (ellipsoid, tiling, scheduler). No render or precision tests.
- **osgEarth:** Catch2 unit tests (`osgearth_tests`: spatial references, extents). Example applications (`osgearth_transform`, `osgearth_eci`) for manual checks, and `osgearth_benchmarks`.

**Gap:** no project has an automated test that measures street-level jitter. deck.gl's comparison of GPU and CPU projections is the closest model, and VibeGlobeEngine must build its own (F057).

## 6. Literature

- **Cozzi and Ring, _3D Engine Design for Virtual Globes_ (2011), chapter 5 "Vertex Transform Precision".**
  - Explains jitter as float32 rounding of large translations.
  - Covers RTC (per-object center, model-view computed in double on the CPU), RTE on the CPU (rewriting vertices each frame) and RTE on the GPU with encoded high/low, including a variant based on DSFUN90 double-float arithmetic.
  - It recommends RTC for small, static geometry and GPU RTE for large or dynamic geometry. It notes the attribute-memory cost and the precision limit of the simple split.
- **Ohlarik, "Precisions, Precisions" (AGI, 2008).** The source of the 65536 split that CesiumJS and OpenGlobus use. It is cited in Cesium's shader.
- **Dekker (1971) and Knuth (TwoSum); Thall, "Extended-Precision Floating-Point Numbers for GPU Computation" (2006).** The error-free transforms behind luma.gl's fp64. They are correct only if the compiler keeps every rounding step.
- **Sterbenz lemma (Goldberg, 1991).** If y/2 ≤ x ≤ 2y then x − y is exact in floating point. This is why subtracting two nearby float32 values that are already rounded loses nothing. The chosen design relies on it.
- **WGSL specification.**
  - "An implementation may reassociate operations".
  - Operations may be fused when this is at least as accurate.
  - f32 `sin`/`cos` only guarantee an absolute error of 2⁻¹¹ on [−π, π], which is about 3 km on an Earth-radius sphere.

## 7. Comparison of approaches

The figures assume a camera 1 m above the ground and f = 1000 px. `D` is the distance from the eye to the chunk origin, `R` the chunk radius and `d` the distance to the vertex. The moving error is the part that changes with the camera, which is what appears as jitter.

| Approach                                                                                  | Used by                                                                                | Moving error at 1 m                                                                        | GPU and memory cost                         | Failure modes                                                                                                                                        |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Absolute float32 coordinates (or GPU float32 product of absolute model and view matrices) | three.js `WebGPURenderer` default, naive custom layers                                 | 0.25–1 m, so hundreds of px                                                                | none                                        | Snapping or jumping (three.js#30955, maplibre#4871, itowns#2023)                                                                                     |
| RTC: float32 local positions, model-view computed in float64 on the CPU                   | Cesium globe tiles, MapLibre Mercator, iTowns, osgEarth, 3DTilesRendererJS (via WebGL) | ≈ c·u·(D+R): 0.04 px for a level-18 tile; about 2.5 px for a level-12 parent-fallback tile | 1 matrix per draw                           | Large chunks near the eye. Chunks must be small, or must be split                                                                                    |
| GPU RTE, 65536 split                                                                      | Cesium primitives, OpenGlobus entities                                                 | Up to about 4 mm, so about 4 px stepping                                                   | 2× position attributes (4× with morph)      | Quantization (cesium#11657). Compiler rewriting (cesium#9417, #7100). Attribute limits (13 in Cesium polylines)                                      |
| GPU RTE, float-float split (high = fround(x)) / auto offset                               | deck.gl `positions64Low` and auto offset                                               | ≈ c·u·d, about 0.0002 px, if evaluated as written                                          | 2× position attributes                      | Reassociation is allowed by WGSL and observed on Metal and ANGLE. Then it falls back to absolute float32                                             |
| Emulated fp64 in the shader                                                               | deck.gl `Fp64Extension` (deprecated), luma.gl                                          | about 10⁻¹⁵ relative                                                                       | about 10× vertex arithmetic, huge shaders   | Silent loss on Apple, NVIDIA and Intel compilers (luma.gl#1764). D3D12 compile timeouts and Vulkan cancellation (#3425). Metal needs an integer path |
| Floating origin with lazy re-base                                                         | 3DTilesRendererJS `ModelViewBatchedMesh`, `ReorientationPlugin`                        | 0 between re-bases; ≤ u·(re-base distance) jump at each re-base                            | CPU re-base cost                            | Rare one-frame jumps. World-space shader math is only small near the origin                                                                          |
| Unit-sphere globe with shader trig, Mercator at high zoom                                 | MapLibre globe, deck.gl `GlobeView`                                                    | ≥ 0.4 m plus trig error (up to km on Mali, Intel, SwiftShader)                             | none                                        | Only usable above about zoom 12 (maplibre#7419, deck.gl#10804)                                                                                       |
| **Camera-relative RTC with a split per-draw origin offset** (chosen)                      | OpenGlobus segments (in part)                                                          | ≈ c·u·d; worst case under rewriting = plain RTC                                            | 2 vec3 uniforms per draw, no attribute cost | Requires chunking of every geometry. See §8                                                                                                          |

### WebGPU and WebGL2

- Neither backend has float64 in shaders.
- WGSL explicitly allows reassociation. Dawn's backends (Metal, D3D12, Vulkan) each showed a different hazard for compensated arithmetic (luma.gl).
- On WebGL2, ANGLE maps to the same native compilers. Cesium#9417 and deck.gl#8235 show the same reorderings. `invariant gl_Position` is a partial and unreliable fix.
- Both backends' minimum vertex-attribute limit is 16. Per-vertex RTE combined with the morph and line adjacency exhausts it.
- The chosen approach uses only additions and a 3×3 rotation, identical on both backends. That supports the backend-consistency target.
- Absolute positions are never derived from trig, so SwiftShader-based CI can validate precision.

### Morph and precision

The morph needs a globe position and a flat position for every vertex. The studied projects handle it as follows:

- **Cesium:** blends absolute 2D and 3D world positions (RTE each, or no RTC for tiles). That is imprecise mid-morph and broke at t = 1 when `mix` or branches were rewritten (#12879).
- **MapLibre:** blends clip-space results of two independent precise paths. That avoids a shared frame but makes the intermediate shape non-metric (z is special-cased).
- **VibeGlobeEngine needs a true 3D morph surface** (tilt, terrain, depth testing).

The precise form follows from linearity. Let G be the globe position, F the flat position placed in the morph frame, and E the eye. Then:

- W − E = (1−m)(G − E) + m(F − E).
- Both terms are eye-relative and computed from chunk-local offsets plus split per-draw offsets. They are combined as `(1−m)·a + m·b`, which is exact at both endpoints, and never as `mix` or `a + m(b−a)`.
- Separate pipelines for m = 0, 0 < m < 1 and m = 1 guarantee that street level (m = 1) does not even contain the globe term.
- During the morph the camera is at country scale, so the remaining c·u·(|a| + |b|) error (well under 1 m) is sub-pixel.

### Camera matrices

- **Matrices must be eye-relative.** A float32 view matrix with an absolute translation is the jitter source in three.js#30955. So is a float32 view-projection applied to absolute positions.
- **The rotation and projection parts are harmless in float32:** relative error u, so 6·10⁻⁸·d.
- **Camera state must be float64 and re-derived each frame** from position and heading/tilt/roll, not accumulated in float32 (3DTilesRendererJS GlobeControls note).
- **Picking and unprojection must be float64** with eye-relative rays (osgEarth#181).
- **Shaders that need the Earth** (atmosphere, horizon) should receive the Earth center relative to the eye. Its 0.4 m float32 error is irrelevant at atmospheric scale.

## 8. Chosen approach for VibeGlobeEngine

Decided in [ADR 0004](../adr/0004-precision-strategy.md): **camera-relative rendering with float64 chunk origins and a split per-draw offset.**

1. All CPU math is in float64 (`Float64Array`): geodesy, camera, culling, chunk origins. `Math.fround` is used only where data is uploaded.
2. Every GPU geometry chunk (terrain or imagery tile, data-layer cell, model, 3D Tiles content) has a float64 origin O. Its positions are float32 or quantized offsets from O.
3. Each frame, for each drawn chunk, the CPU computes T = O − E in float64 and uploads T_hi = fround(T) and T_lo = fround(T − T_hi).
   - The view matrix is rotation-only (the eye is at the origin of the world frame).
   - Engine shaders evaluate (offset + T_hi) + T_lo before the rotation. The first sum is exact by Sterbenz near the eye.
   - Third-party materials (for example glTF models) receive the plain camera-relative `matrixWorld`.
   - This works with three.js's default node path without `highPrecision` and keeps `positionWorld` (fog, lighting, shadows) eye-relative.
4. **Chunk-size rule.** This is the guarantee if a compiler rewrites the order of the sum: the radius of a chunk drawn at distance d from the eye stays ≤ 1000·d. Plain RTC then stays at or below about 0.4 px. Street-level parent fallback therefore draws ancestor data on child-sized geometry. Long data-layer features are cut into spatial cells. Per-vertex high/low RTE is not used.
5. **Morph.** Globe and flat positions are both chunk-relative, with their own float64 origins. They are blended eye-relative as (1−m)·a + m·b, with dedicated pipelines at m = 0 and m = 1.
6. **No absolute positions from GPU trig or geodesy.**

### What M2 must measure, and how

- **GPU readback test (both backends, plus SwiftShader in CI).** Draw tracked vertices as points whose flat varying carries the clip position into an `rgba32float` target. Compare with the float64 projection.
  - Targets: ≤ 0.01 px with the split, and ≤ 0.4 px with T_lo forced to 0 (the rewrite-fallback case).
  - Locations: (0°, 0°), Milan, Tokyo, Sydney, ±179.9999° longitude, ±85.05° latitude, Everest summit, Dead Sea shore.
- **Reassociation canary.** A shader self-test whose result differs when (a+b)+c is rewritten. The result is recorded per device in the hardware matrix.
- **Scenario `street-level-jitter` (F057).** 1 m altitude, sub-millimetre moves and slow rotation, frame tracking. Residual ≤ 0.1 px.
- **Morph test.** Sweep m from 0 to 1. The anchor stays within 0.1 px, and the m = 1 frames match the pure-flat pipeline.
- **Unit and property tests (Vitest).**
  - Emulate the shader arithmetic with `Math.fround` over random positions and eyes worldwide.
  - Check camera matrices against reference values (F047).
  - Check that a matrix times its inverse gives the identity within 10⁻¹².
- **Benchmarks.**
  - CPU cost of the per-frame offsets for 1k, 5k and 20k draws (target ≤ 0.1 ms for 5k on the reference desktop, zero allocation).
  - GPU frame time with and without the split on the reference tablet. The expected difference is within noise.

## 9. Open questions

- **Acceptance threshold.** `docs/plan/quality.md` and `architecture.md` (0.5 px variance) disagree with F057/F078 (0.1 px residual). The design targets 0.1 px. The plan documents should be aligned.
- **Does three.js TSL keep the operand order** of the offset sums through WGSL and GLSL code generation? The readback test and the canary will tell. If not, a raw WGSL/GLSL snippet node may be needed.
- **The exact chunk-size constant** (1000·d) and the cell level for data layers (a level-12 to level-15 grid) must be set from the M2 measurements and the level-of-detail survey.
- **Morph frame and endpoint variants.** [ADR 0008](../adr/0008-globe-to-flat-morph.md) puts the morph in the anchor's east-north-up frame with per-tile globe and plane offsets, which fits this design. It makes the m = 0 and m = 1 shader variants conditional on GPU cost, whereas ADR 0004 requires them for precision. ADR 0008's M5 follow-up should record this.
- **Whether to also enable `renderer.highPrecision`** as defense in depth for application-supplied objects that bypass the engine. To be decided in M10.
