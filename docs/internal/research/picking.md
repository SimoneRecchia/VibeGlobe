# Picking

- Status: Complete (survey for M10)
- Date: 2026-10-22
- Decision: [ADR 0029](../adr/0029-data-layers.md)

## 1. Scope and requirements

This survey covers finding what is under the pointer: data-layer features (points, markers, billboards, lines, polygons, extrusions, models), bare terrain, and clusters and labels. It compares GPU id buffers, ray casting and CPU spatial indices. It also covers what a pick costs per frame, how readback avoids stalls, and how picks stay correct at street level and while the camera moves.

PLAN.md requirements it serves:

- **Data layers for applications, "Interaction":** hover, click, selection highlight, optional dragging. Events carry the feature and its coordinates, and picking also works on bare terrain.
- **Engineering standards:** no glitches, a free main thread, the frame budget.
- **Precision and depth** (ADR 0004, ADR 0005): float64 on the CPU, camera-relative positions on the GPU, one reversed-Z float depth encoding.
- **Feature list:** F348 (this survey), F379 to F384 (hover, click, selection, drag, bare-terrain picking, correct picks in every phase, at street level and during motion), F388 (custom layers pick like built-in layers).

## 2. Projects studied

| Project        | Version / commit                             | License      | Files read                                                                                                                                                                                                                                                                                             |
| -------------- | -------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CesiumJS       | 1.146.0, [`0c09769`][ce]                     | Apache-2.0   | `packages/engine/Source/Scene/{Picking,PickFramebuffer,Globe}.js`, `Source/Renderer/Context.js` (`createPickId`), `Source/Core/TerrainPicker.js`, `Specs/Scene/PickingSpec.js`, `Specs/pick.js`, `Specs/e2e/picking.spec.js`, `CHANGES.md`                                                             |
| MapLibre GL JS | 6.15.0, [`49f780a`][ml]                      | BSD-3-Clause | `src/data/feature_index.ts`, `src/source/query_features.ts`, `src/geo/projection/mercator_transform.ts` (`_raycastTerrain`), `src/render/terrain.ts`, `src/data/feature_index.bench.ts`, `test/integration/query/`, `CHANGELOG.md`                                                                     |
| deck.gl        | 9.4.0-beta.4, [`ce528a4`][dg]                | MIT          | `modules/core/src/lib/{deck,deck-picker}.ts`, `src/passes/pick-layers-pass.ts`, `src/lib/picking/query-object.ts`, `src/shaderlib/picking/picking.ts`, `modules/extensions/src/terrain/terrain-picking-pass.ts`, `test/interaction/picking.spec.ts`, `test/bench/pick-layers.bench.js`, `CHANGELOG.md` |
| three.js       | r186 (0.186.0), [`758330b`][th]              | MIT          | `src/core/Raycaster.js`, `src/renderers/common/Renderer.js` (`readRenderTargetPixelsAsync`), `manual/examples/picking-{gpu,raycaster}.html`, `examples/jsm/interactive/SelectionBox.js`, commit history                                                                                                |
| OpenLayers     | 10.11.1-dev, [`73c527c`][ol]                 | BSD-2-Clause | `src/ol/render/canvas/{hitdetect,ExecutorGroup}.js`, `src/ol/renderer/webgl/VectorLayer.js`, `src/ol/render/webgl/encodeUtil.js`, `test/browser/spec/ol/Map.test.js`, `changelog/`                                                                                                                     |
| iTowns         | 2.46.0, [`d6ee354`][it]                      | CeCILL-B/MIT | `packages/Main/src/Core/{Picking,View}.js`, `test/functional/misc_clamp_ground.js`, `changelog.md`, commit history                                                                                                                                                                                     |
| Potree         | 1.8.0, [`5636cd4`][po]                       | BSD-2-Clause | `src/PointCloudOctree.js` (`pick`), commit history                                                                                                                                                                                                                                                     |
| rbush, kdbush  | 4.0.1 [`e597127`][rb], 4.1.0 [`cc2c285`][kd] | MIT, ISC     | `README.md`, `index.js`, `bench/`, `bench.js`                                                                                                                                                                                                                                                          |

Issue and pull request numbers below come from the projects' changelogs and commit messages. The GitHub issue pages were not reachable from the research container.

## 3. How each project picks

**CesiumJS.**

- **Ids:** `Context.createPickId` hands out a 32-bit counter value per pickable object and keeps a `Map` from the value to the object. The value is written as an RGBA8 colour. Every pickable billboard, point or geometry instance owns a `PickId` object.
- **Pick pass:** `Picking.pick` re-renders the whole scene into a `PickFramebuffer`, scissored to a 3 × 3 px rectangle (default `width = height = 3`). It also narrows the culling volume to that rectangle (`getPickCullingVolume`), so only commands under the cursor are drawn.
- **Nearest hit:** `pickObjectsFromPixels` spirals outward from the centre pixel and returns the first id it finds. The source comments call this "a workaround until we can access the depth buffer on all browsers".
- **Readback:** `pick` is synchronous (`readPixels`). `pickAsync` (WebGL2 only) reads into a PBO and waits on a fence (`Sync`), so the CPU never blocks ([#12983][ce-12983]).
- **Position:** `pickPosition` reads the depth of each of Cesium's multiple frustums from `PickDepth` framebuffers and unprojects. Results are cached per frame ([#5117][ce-5117]).
- **Terrain:** `Globe.pickWorldCoordinates` tests the ray against the bounding spheres of the rendered tiles, sorts the hits by distance, and intersects the triangles of each tile. A per-tile quadtree (`TerrainPicker`, at most 4 levels) speeds this up ([#8481][ce-8481]). It returns the closest triangle, not the first one found ([#8390][ce-8390]).
- **Drill picking:** `drillPick` repeats the pick, hiding each hit, until nothing is left.

**MapLibre GL JS.**

- **No GPU feature ids.** `queryRenderedFeatures` is pure CPU work.
  - Each tile keeps a `FeatureIndex` built in the worker: a `TransferableGridIndex` (16 × 16 cells over the 8192 extent) of feature bounding boxes, plus a second grid for 3D features (extrusions).
  - A query converts the screen geometry into tile coordinates, pads it by the largest style size (`queryPadding`), takes the grid candidates, and runs each style layer's exact `queryIntersectsFeature` test, which accounts for line width, circle radius, translate and pitch.
  - Symbols are queried against the collision index of the last placement.
- **Terrain:** `screenTerrainPointToMercatorCoordinate` marches the pixel ray against the DEM tiles' coverage index.
  - It clips the ray to the min/max elevation slab, takes fixed world-pixel steps, and bisects the first step that goes below the surface.
  - This replaced a coordinate framebuffer readback: "full DEM resolution, no GPU stall on pointer events, and about 4MB less GPU memory" ([#7640][ml-7640]).

**deck.gl.**

- **Encoding:** RGB holds `index + 1` of the object within its layer (24 bits). Alpha holds the layer index, written through the blend constant (`encodeColor` in `pick-layers-pass.ts`). Zero means nothing. With more than 255 pickable layers it warns: "Too many pickable layers, only picking the first 255".
- **Pass:** the picking pass draws only pickable layers into an off-screen framebuffer, restricted to the rectangle `pickingRadius` defines around the pointer.
- **Nearest hit:** `getClosestObject` scans the rectangle and keeps the pixel with a non-zero layer that is closest to the pointer, within the radius.
- **Scheduling:** pointer events only record a `_pickRequest`. The animation loop resolves it once per frame ("Only pick once per animation frame", [#2839][dg-2839]). Async hover picks carry a `_hoverPickSequence` number, so a late result cannot overwrite a newer one.
- **Readback:** async picking (`pickObjectAsync`, [#9733][dg-9733]) is the default on WebGPU. WebGPU rejects `pickAsync: "sync"`.
- **3D position:** `unproject3D` runs a second pass that encodes depth.
- **Draped layers:** the TerrainExtension renders draped layers into a per-terrain-tile "cover" texture, plus a separate picking cover that holds picking colours (`TerrainPickingPass`, [#8474][dg-8474], [#10037][dg-10037]).

**three.js.**

- **`Raycaster`:** CPU tests in world units. `Line` and `Points` take a `threshold` in world units rather than pixels, and results are sorted by distance. Large meshes need a BVH (the third-party three-mesh-bvh).
- **GPU picking example:** each object gets an id written as an emissive colour.
  - `camera.setViewOffset` shrinks the frustum to the single pixel under the pointer.
  - The scene is drawn into a 1 × 1 render target and read with `readRenderTargetPixels`.
- **Async readback:** `readRenderTargetPixelsAsync` exists on `WebGPURenderer` ([#26326][th-26326]) and on `WebGLRenderer` ([#28291][th-28291]).

**OpenLayers.**

- **Canvas renderer:** `forEachFeatureAtPixel` replays the vector instructions of each layer into a small `2·hitTolerance + 1` px canvas centred on the pixel. It then reads `getImageData` in order of distance from the centre and reports features whose drawing set alpha.
- **`getFeatures(pixel)`:** this method ([#10094][ol-10094]) renders the whole layer once into a hit-detection image (`createHitDetectionImageData`), with the colour index stretched over 24 bits.
- **WebGL vector layer:** it renders a hit target at half resolution on every frame while hit detection is enabled. It decodes a 32-bit id from RGBA (`colorDecodeId`) with a synchronous `readPixel`.

**iTowns.**

- **Tiles:** an id render mode draws tile ids into a `(2r + 1)²` px buffer (`screenCoordsToNodeId`).
- **Objects:** `pickObjectsAt` raycasts with three.js when `radius = 0`. Otherwise it renders the zone, with clear alpha 0, and raycasts only through the pixels that were drawn.
- **Draped vector features:** these are rasterized into tile textures, so `pickFeaturesAt` reads the depth buffer to get the geographic position. It then tests the tile's feature geometry on the CPU (`filterFeaturesUnderCoordinate`) with a tolerance of `radius` pixels converted to metres.
- **Readback:** all of these use synchronous readbacks.

**Potree.**

- **Window:** `PointCloudOctree.pick` keeps only the nodes the ray crosses and renders them into a scissored window, 65 × 65 px by default.
- **Encoding:** RGB holds the point index within the node (24 bits) and alpha holds the node's index among the visible nodes (8 bits). This is the same split as deck.gl.
- **Nearest hit:** chosen by squared distance to the centre, then read with a synchronous `gl.readPixels`.

**CPU spatial indices.**

- **rbush:** a dynamic R-tree with bulk loading, insert and remove.
- **kdbush:** a static flat k-d tree for points, which its README says indexes "5-8x faster than RBush".
- **Uses in the studied engines:**
  - Cesium's `EntityCluster` and supercluster use kdbush.
  - OpenLayers' vector source uses rbush.
  - MapLibre uses a uniform grid per tile.

## 4. Approaches and trade-offs

| Approach                                             | Used by                                                             | Strengths                                                                                                                      | Weaknesses                                                                                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GPU id buffer, small region, on demand               | Cesium, deck.gl, Potree, three.js GPU example                       | Exactly what the shaders drew: screen-space sizes, terrain occlusion, extrusion, instancing. Cost independent of feature count | An extra pass per pick. Synchronous readback stalls the pipeline. Drawn pixel only (thin lines need a radius). A separate path is needed for draped content |
| GPU id buffer every frame                            | OpenLayers WebGL                                                    | Pick is a single readback                                                                                                      | Pays the pass on every frame. Half resolution misses thin features                                                                                          |
| CPU ray casting against meshes                       | three.js `Raycaster`, iTowns (radius 0)                             | No GPU work, exact intersection, works without a frame                                                                         | Must replicate shader math (screen-space widths, billboards, morph). Cost grows with geometry unless there is a BVH                                         |
| CPU spatial index + exact geometric test             | MapLibre `queryRenderedFeatures`, OL canvas, iTowns draped features | Box and polygon queries, no GPU, works on any data                                                                             | Re-implements every style's geometry in JS. 3D (terrain, extrusion, globe) makes it complex. Bug-prone (see §5)                                             |
| CPU ray–terrain (heightfield march or triangle test) | MapLibre (since #7640), Cesium `Globe.pick`                         | Full DEM resolution, no stall, no GPU memory                                                                                   | Must sample the same level as the drawn mesh, or it disagrees with what is shown                                                                            |
| Depth readback for position                          | Cesium `pickPosition`, iTowns, deck.gl `unproject3D`                | Exact position of whatever was drawn                                                                                           | Only as precise as the depth encoding. Multi-frustum and log depth complicate it                                                                            |

## 5. Known failure modes

**Missed or wrong picks on terrain.**

- Cesium:
  - globe picking returned "the first intersecting triangle" instead of the closest one ([#8390][ce-8390]);
  - "`scene.pickFromRay` intersection inaccuracies" ([#8439][ce-8439]);
  - "`scene.pickPosition` returned incorrect results against the globe when `depthTestAgainstTerrain` is `false`" ([#4368][ce-4368]);
  - wrong results "when called after `sampleHeight` or `clampToHeight`" ([#7113][ce-7113]).
- MapLibre:
  - "`project()` and `queryTerrainElevation` disagreeing with the rendered terrain surface when the elevation lookup sampled a different DEM zoom than the drawn mesh" ([#8212][ml-8212]);
  - "stale terrain depth and coordinate framebuffers when terrain tiles change without camera movement" ([#7812][ml-7812]).
- iTowns: `readDepthBuffer()` returned the wrong value because it drew the cone in front of itself (bug #747 in `test/functional/misc_clamp_ground.js`). Its depth-precision test ("error inferior to 2‰") is disabled (`xit`).

**Precision at street level.**

- Cesium's multi-frustum depth needs per-frustum handling in every depth consumer, which is the root of [#4368][ce-4368] (see ADR 0005).
- MapLibre's globe is float32 on a unit sphere, so it hands over to Mercator at zoom 12 (precision survey). Its picks inherit the same split.
- three.js `Raycaster` thresholds are in world units, so a 1-unit line threshold is meaningless at both 1 m and 1,000 km from the camera.

**Cost per frame.**

- Cesium:
  - re-rendering for picking motivated the per-frame `pickPosition` cache ([#5117][ce-5117]), the terrain quadtrees ([#8481][ce-8481]) and `pickAsync` "for non GPU blocking picking" ([#12983][ce-12983]);
  - `drillPick` on ground-clamped geometry hung the browser ([#5971][ce-5971], [#6907][ce-6907]).
- Potree: "fix scissor test during picking. previously, the whole screen was rendered instead of the small pick window" ([`d7abbe7`][po-scissor]).
- deck.gl: limited per-frame picking to one pick per animation frame ([#2839][dg-2839]) and improved multi-picking performance ([#3668][dg-3668]).
- OpenLayers: added "Avoid unnecessary getImageData calls in hit detection" ([#5597][ol-5597]) and "Lazily create the hit detection context" ([#9546][ol-9546]).
- MapLibre: removed the coordinate framebuffer, partly to stop GPU stalls on pointer events ([#7640][ml-7640]).

**Picking during motion and live updates.**

- Cesium: "translucent objects could flicker when picking on mouse move" ([#5307][ce-5307]); picking broke "when the Sun came into view" ([#5478][ce-5478]).
- deck.gl:
  - "Fix picking color values coming from a reallocated buffer" ([#5503][dg-5503]), meaning ids that went stale after a data update;
  - "do not write View clearColor into the picking buffer" ([#10431][dg-10431]);
  - the hover sequence counter that drops stale async results.
- OpenLayers: "Do not hit detect while tile is loading" ([#10293][ol-10293]).
- MapLibre: `queryRenderedFeatures` raced tile reloads ([#8064][ml-8064], [#7765][ml-7765]).
- iTowns: "make object picking robust by comparing alpha instead of colors" ([`2987cb1`][it-alpha]), because an object's colour can equal the clear colour.

**Pixel ratio and tolerance.**

- OpenLayers: `hitTolerance` was multiplied by the device pixel ratio twice (upgrade notes); "Fix hit detection for webgl layers on retina devices" ([#9767][ol-9767]).
- deck.gl: "Fix missing picking radius for onClick handlers" ([#6208][dg-6208]).

## 6. How they test and benchmark

- **CesiumJS:**
  - Jasmine specs on a real WebGL context. `PickingSpec.js` has 130 cases, using matchers such as `toPickPrimitive`, `toDrillPickAndCall` and `toPickPositionAndCall`.
  - `Specs/pick.js` renders a 1 × 1 `PickFramebuffer` directly.
  - A Playwright end-to-end test (`Specs/e2e/picking.spec.js`) moves the mouse and compares a screenshot.
- **MapLibre:**
  - Data-driven query tests (`test/integration/query/tests/`, 31 groups such as `circle-radius`, `line-width`, `fill-extrusion`, `regressions/mapbox-gl-js#…`). Each test pairs a style and a query geometry with an expected JSON result.
  - Benchmarks for `feature_index` and for the terrain raycast (`mercator_transform.bench.ts`).
- **deck.gl:**
  - `test/interaction/picking.spec.ts` (hover on a rendered deck).
  - `test/bench/pick-layers.bench.js` times `getClosestObject` on synthetic pixel buffers (solid, circle, triangle shapes).
- **OpenLayers:** browser specs for `forEachFeatureAtPixel` and `getFeaturesAtPixel` (including geographic coordinates, [#9993][ol-9993]), and fixed pixel ratios in hit-tolerance tests ([#6472][ol-6472]).
- **iTowns:** Puppeteer functional tests (`misc_clamp_ground.js`) that compare depth picking with the controls' own computation.
- **three.js and Potree:** no automated picking tests; only examples.

**Lesson:** the useful pattern is a known scene, a known screen point and an exact expected feature or position (Cesium, MapLibre). Benchmarks of the decode step are cheap to run in Node (deck.gl).

## 7. Chosen approach and why

1. **GPU id buffer for features, rendered on demand.**
   - **When it runs:** only when a pointer event arrives, or when the camera or the layer data changed while hover listeners exist. It runs at most once per frame (deck.gl #2839).
   - **Region:** only a small region around the pointer, 5 × 5 px by default, in device pixels.
   - **Culling:** the pass culls with a frustum narrowed to that region (as Cesium does), so its cost does not depend on the number of features.
   - **What it draws:** opaque-only state with no blending and a cleared value of 0 (deck.gl #10431). Draped content and terrain are not drawn into the id buffer; terrain is handled by point 4.
2. **32-bit id in RGBA8.**
   - **Split:** an 8-bit layer slot plus a 24-bit feature index, with 0 meaning nothing. This is the split deck.gl and Potree converged on.
   - **Slot table:** a per-frame slot table maps slots back to layers, and the layer maps the index back to its feature through its structure-of-arrays storage.
   - **Why not Cesium's scheme:** Cesium keeps one `PickId` object and one `Map` entry per feature. That costs memory and garbage for 100,000 features and needs explicit release.
   - **Data updates:** ids are row indices, so a single-feature update (data-layers survey) never invalidates other ids. That avoids deck.gl's #5503 problem.
3. **Asynchronous readback, reconciled with its frame.**
   - **Mechanism:** a WebGPU `copyTextureToBuffer` plus `mapAsync`, or a WebGL2 PBO plus `fenceSync` (as Cesium #12983 and three.js do).
   - **Tagging:** each request carries the frame number, the pointer position and the layer data version it was rendered with.
   - **Resolution:** the result is resolved against the slot table of that frame. It is dropped if a newer request has already resolved, as deck.gl does with `_hoverPickSequence`. Hover events therefore never step backwards.
   - **Nearest hit:** among non-zero pixels, the one closest to the pointer wins (as deck.gl's `getClosestObject`); the id buffer is depth-tested, so each pixel already holds the topmost feature, and equal distances go to the first pixel in row order so the answer depends only on the pixels (`packages/layers/src/picking.ts`).
4. **Same positions as the visible frame.** The pick pass reuses the frame's camera-relative draw origins and morph state (ADR 0004). The picked feature is therefore the one displayed in that frame, in every phase and while the camera moves. Neither MapLibre's CPU path nor three.js world-unit thresholds guarantee this.
5. **Positions and bare terrain on the CPU.**
   - **Ray march:** the pick ray is marched against the heights of the loaded terrain tiles, using the best loaded level, which is the level being drawn (MapLibre #8212). The ray is clipped to each tile's min/max height, then bisected, as MapLibre does since #7640.
   - **Refinement:** the pick pass also writes the view distance (reversed-Z float depth gives about 1e-7·d, ADR 0005). The terrain hit is refined, and a feature's hit position is computed, from that depth.
   - **Precision:** the result is float64 geographic coordinates and elevation at street level, without multi-frustum handling (Cesium #4368).
6. **CPU spatial indices for 2D screen questions.**
   - **Indices:** kdbush for cluster hit tests (the cluster positions of the current zoom), rbush for label boxes, and rbush on feature bounding boxes for box selection and for draped lines and polygons.
   - **Draped hits:** a draped feature is picked by testing its geometry at the picked terrain position, with a tolerance of the pixel radius converted to metres, as iTowns does. This avoids deck.gl's second "picking cover" texture per terrain tile.
7. **Custom layers (F388):** each custom layer gets a slot and writes the same id format through a shader chunk.

**How this matches or beats the studied engines:**

- **Cost:** it has the exactness of GPU picking (Cesium, deck.gl, Potree) without synchronous stalls (unlike Cesium `pick`, iTowns, Potree and OpenLayers), and it does no per-frame cost when idle (unlike OpenLayers WebGL).
- **Motion:** its ordering rule matches deck.gl, and it adds frame-exact geometry, which nobody else documents.
- **Terrain:** its picking follows the approach MapLibre moved to after measuring the alternative.

**How it will be tested:**

- **Node unit tests:**
  - encode and decode round trips for every slot and index boundary (0, 1, 2²⁴ − 1, 255);
  - slot-table allocation and reuse;
  - nearest-hit selection on synthetic 5 × 5 buffers;
  - dropping stale results by frame and sequence;
  - ray–heightfield intersection against analytic surfaces (plane, slope, peak) with known answers.
- **Playwright on both backends:**
  - each primitive is picked at projected screen points in the globe, 2D and tilted phases;
  - street-level picks at 1 m camera height;
  - picks during a scripted camera flight, where every frame's result must equal the feature the CPU projects under the pointer for that frame;
  - bare-terrain picks compared with the DEM height at the picked coordinate (F383, F384).
- **Benchmark:** frame time with continuous hover picking against the same scene without picking, plus pointer-to-event latency.

## 8. Open questions

1. **Layer slots:** 8 bits allow 255 pickable layers per frame (deck.gl warns at that limit). Should a layer with more than 2²⁴ features, such as a point cloud, take several slots as Potree does with nodes, or should the split become 10 + 22 bits? Decide when the first such layer exists.
2. **Draped picking:** CPU tests of draped features against the picked terrain position are simpler and use no extra GPU memory. deck.gl instead renders an id cover per terrain tile, which matches the rasterized drape exactly at the edges. Revisit only if tests show edge mismatches above 1 px.
3. **Depth readback on WebGL2:** WebGL2 cannot read a depth texture, so the pick pass writes distance to a second colour attachment. Should it be `R32F` (needs `EXT_color_buffer_float`, which is near-universal) or distance packed into RGBA8? WebGPU can copy `depth32float` directly.
4. **Translucent and drill picking** (`drillPick`): not in the feature list, and costly and hang-prone in Cesium (#5971, #6907). Recorded as a follow-up, not built.
5. **Evidence against the choice:** MapLibre shows that a CPU index with exact style tests serves 2D vector-tile picking well and needs no GPU pass. GPU ids are still chosen for data layers because of 3D, instancing, screen-space sizes and terrain occlusion. Vector-tile layers (M13) may reuse MapLibre-style CPU queries; to be decided in that survey.

[ce]: https://github.com/CesiumGS/cesium/tree/0c09769c7570131fef452e2af1688538ca383917
[ce-12983]: https://github.com/CesiumGS/cesium/pull/12983
[ce-5117]: https://github.com/CesiumGS/cesium/issues/5117
[ce-8481]: https://github.com/CesiumGS/cesium/issues/8481
[ce-8390]: https://github.com/CesiumGS/cesium/pull/8390
[ce-8439]: https://github.com/CesiumGS/cesium/issues/8439
[ce-4368]: https://github.com/CesiumGS/cesium/issues/4368
[ce-7113]: https://github.com/CesiumGS/cesium/pull/7113
[ce-5971]: https://github.com/CesiumGS/cesium/issues/5971
[ce-6907]: https://github.com/CesiumGS/cesium/issues/6907
[ce-5307]: https://github.com/CesiumGS/cesium/issues/5307
[ce-5478]: https://github.com/CesiumGS/cesium/issues/5478
[ml]: https://github.com/maplibre/maplibre-gl-js/tree/49f780a03846d1d810316c3a5b5446617e197e94
[ml-7640]: https://github.com/maplibre/maplibre-gl-js/issues/7640
[ml-8212]: https://github.com/maplibre/maplibre-gl-js/issues/8212
[ml-7812]: https://github.com/maplibre/maplibre-gl-js/pull/7812
[ml-8064]: https://github.com/maplibre/maplibre-gl-js/issues/8064
[ml-7765]: https://github.com/maplibre/maplibre-gl-js/pull/7765
[dg]: https://github.com/visgl/deck.gl/tree/ce528a4074ee813ac4f6b9b0e7976935519ac3f7
[dg-2839]: https://github.com/visgl/deck.gl/pull/2839
[dg-9733]: https://github.com/visgl/deck.gl/pull/9733
[dg-8474]: https://github.com/visgl/deck.gl/pull/8474
[dg-10037]: https://github.com/visgl/deck.gl/pull/10037
[dg-3668]: https://github.com/visgl/deck.gl/pull/3668
[dg-5503]: https://github.com/visgl/deck.gl/pull/5503
[dg-10431]: https://github.com/visgl/deck.gl/pull/10431
[dg-6208]: https://github.com/visgl/deck.gl/pull/6208
[th]: https://github.com/mrdoob/three.js/tree/758330b15ed854cd72f26cafa3ff41a153a8e9ca
[th-26326]: https://github.com/mrdoob/three.js/pull/26326
[th-28291]: https://github.com/mrdoob/three.js/pull/28291
[ol]: https://github.com/openlayers/openlayers/tree/73c527cd47863d526fee5e50ccec9831082e61b7
[ol-10094]: https://github.com/openlayers/openlayers/pull/10094
[ol-5597]: https://github.com/openlayers/openlayers/pull/5597
[ol-9546]: https://github.com/openlayers/openlayers/pull/9546
[ol-10293]: https://github.com/openlayers/openlayers/pull/10293
[ol-9767]: https://github.com/openlayers/openlayers/pull/9767
[ol-9993]: https://github.com/openlayers/openlayers/pull/9993
[ol-6472]: https://github.com/openlayers/openlayers/pull/6472
[it]: https://github.com/iTowns/itowns/tree/d6ee3549bfaf83ebe79d039337e73155227b7d64
[it-alpha]: https://github.com/iTowns/itowns/commit/2987cb1cae1efa068d9b06ef69f21de9a828ef5f
[po]: https://github.com/potree/potree/tree/5636cd471d9eb464969e758be45c44d7613d3859
[po-scissor]: https://github.com/potree/potree/commit/d7abbe7739a251e92047e06a0e8cb12005662446
[rb]: https://github.com/mourner/rbush/tree/e59712716a84dda2e31f9b471b32faa178d8056f
[kd]: https://github.com/mourner/kdbush/tree/cc2c28592c23a2d2542a5670fbdd1fbec32535dd
