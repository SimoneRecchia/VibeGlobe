# Data-layer primitives, draping, clustering and massive point data

- Status: Complete (survey for M10)
- Date: 2026-10-22
- Decision: [ADR 0029](../adr/0029-data-layers.md)

## 1. Scope and requirements

This survey covers how application data is drawn on a globe: the primitives themselves (points, markers and billboards, polylines, polygons), storage and live updates, and draping lines and polygons on terrain. It also covers clamping markers and models to the ground, clustering, marker level of detail, data-driven styling, and datasets of hundreds of thousands of points. Picking has its own survey ([`picking.md`](picking.md)). Labels have theirs ([`labels.md`](labels.md)).

PLAN.md requirements it serves:

- **Data layers for applications:**
  - primitives;
  - placement: draped, clamped and "re-adjusted when terrain detail changes", or absolute;
  - large datasets "from thousands to hundreds of thousands of points, with clustering and level of detail for markers";
  - live updates "without rebuilding the layer";
  - data-driven and zoom-dependent styling.
- **Rendering quality, "Draping":** polygons and lines "follow the relief, never floating above it or cutting into it".
- **Milestone 10 "Done when":** 100,000 points with clustering stay at the target frame rate, and draped shapes follow terrain at every level.
- **Feature list:** F350 (this survey), F351 to F357 (primitives), F362 to F368 (placement, morph, jitter, antimeridian), F369 and F370 (styling), F372 to F378 (streaming, clustering, marker LOD, large layers, single-feature updates, live feed).

## 2. Projects studied

| Project        | Version / commit                             | License      | Files read                                                                                                                                                                                                                                                                                                                                                                          |
| -------------- | -------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CesiumJS       | 1.146.0, [`0c09769`][ce]                     | Apache-2.0   | `packages/engine/Source/Scene/{GroundPrimitive,ClassificationPrimitive,BillboardCollection,QuadtreePrimitive,BufferPrimitiveCollection}.js`, `Source/Core/{VectorProvider,VectorPipeline}.js`, `Source/DataSources/EntityCluster.js`, `Specs/Scene/GroundPrimitiveSpec.js`, `Specs/DataSources/EntityClusterSpec.js`, `CHANGES.md`                                                  |
| deck.gl        | 9.4.0-beta.4, [`ce528a4`][dg]                | MIT          | `modules/extensions/src/terrain/{terrain-extension,terrain-effect,terrain-cover,height-map-builder,shader-module}.ts`, `modules/core/src/lib/attribute/attribute.ts`, `modules/layers/src/{path-layer,icon-layer,arc-layer,solid-polygon-layer}/`, `examples/website/icon/icon-cluster-layer.ts`, `test/render/test-cases/`, `test/bench/attribute-update.bench.js`, `CHANGELOG.md` |
| MapLibre GL JS | 6.15.0, [`49f780a`][ml]                      | BSD-3-Clause | `src/webgl/render_to_texture.ts`, `src/render/{terrain,subdivision}.ts`, `src/source/{geojson_source,geojson_worker_source}.ts`, `src/shaders/glsl/{circle,symbol_sdf}.vertex.glsl`, `test/integration/render/tests/terrain/`, `src/render/subdivision.bench.ts`, `CHANGELOG.md`                                                                                                    |
| OpenLayers     | 10.11.1-dev, [`73c527c`][ol]                 | BSD-2-Clause | `src/ol/source/{Cluster,Vector}.js`, `src/ol/renderer/webgl/VectorLayer.js`, `src/ol/worker/webgl.js`, `test/rendering/cases/webgl-points*`, `changelog/`                                                                                                                                                                                                                           |
| iTowns         | 2.46.0, [`d6ee354`][it]                      | CeCILL-B/MIT | `packages/Main/src/Converter/{Feature2Texture,Feature2Mesh,textureConverter}.js`, `src/Core/Label.js`, `src/Layer/{LabelLayer.js,PointCloudLayer.ts}`, `test/functional/misc_clamp_ground.js`, commit history                                                                                                                                                                       |
| Potree         | 1.8.0, [`5636cd4`][po]                       | BSD-2-Clause | `src/Potree.js`, `src/Potree_update_visibility.js`, `src/PointCloudOctree.js`, commit history                                                                                                                                                                                                                                                                                       |
| supercluster   | 9.1.0, [`641713a`][sc]                       | ISC          | `index.js`, `README.md`, `bench.js`, `demo/worker.js`                                                                                                                                                                                                                                                                                                                               |
| kdbush, rbush  | 4.1.0 [`cc2c285`][kd], 4.0.1 [`e597127`][rb] | ISC, MIT     | `README.md`, `index.js`                                                                                                                                                                                                                                                                                                                                                             |

Libraries considered as dependencies (npm, 2026-10-22):

- `earcut` 3.2.4 (ISC);
- `supercluster` 9.1.0 (ISC);
- `kdbush` 4.1.0 (ISC);
- `rbush` 4.0.1 (MIT);
- `@maplibre/maplibre-gl-style-spec` 26.4.4 (ISC).

Issue numbers come from the changelogs and commit messages. The issue pages were not reachable from the research container.

## 3. How each project solves it

### Primitives and storage

- **CesiumJS:**
  - `BillboardCollection`, `PointPrimitiveCollection` and `PolylineCollection` hold one JS object per item. Setters mark a property bucket dirty (`_propertiesChanged`), and `update` rewrites only the changed attributes through a `VertexArrayFacade`.
  - Billboards are instanced (one vertex per billboard), and textures go into a shared atlas.
  - Static geometry (`Primitive`, `GroundPrimitive`) is batched in workers and is not editable afterwards.
  - The new experimental `BufferPointCollection`, `BufferPolylineCollection` and `BufferPolygonCollection` ([#13212][ce-13212]) store everything in typed arrays with capacity limits. They have batch `setPositions` for "animating vertex positions on a range of many point, line, or polygon primitives" ([#13590][ce-13590]), which is a move towards structure-of-arrays storage.
- **deck.gl:**
  - Layers are columns of typed attributes computed from accessors or supplied as binary arrays ([#8153][dg-8153]).
  - `Attribute.setNeedsUpdate(reason, {startRow, endRow})` merges dirty row ranges, and the layer's `_dataDiff` lets applications update only changed rows.
  - `PathLayer` draws instanced segment quads with `widthUnits` and `widthMinPixels`. `IconLayer` has an auto-packing icon atlas (`IconManager`, 1024 px wide) and `billboard` and `sizeUnits` props.
  - Polygons are triangulated with earcut (`solid-polygon-layer/polygon.ts`). `ArcLayer` has a `greatCircle` option.
- **MapLibre GL JS:**
  - GeoJSON is tiled in a worker (`geojson-vt`). `updateData` applies diffs, and buckets are rebuilt per tile.
  - On the globe, fills and lines are subdivided per tile (`subdivision.ts`). The granularity is set per zoom, so long edges follow the sphere.
- **OpenLayers:** WebGL vector and point layers build their buffers in a worker ([#9562][ol-9562]) and compile style expressions to GLSL ([#10016][ol-10016]).
- **iTowns:** `Feature2Mesh` builds three.js meshes per feature collection, with altitude from a function or from the elevation layer.

### Draping lines and polygons on terrain

- **CesiumJS, shadow volumes:** `GroundPrimitive` and `ClassificationPrimitive` extrude each polygon into a volume between approximate minimum and maximum terrain heights (`ApproximateTerrainHeights`). They stencil the volume against the depth buffer and shade where terrain lies inside it.
  - It is exact at any terrain level and also drapes onto 3D Tiles.
  - The cost is fill rate and stencil passes. It needs depth textures and fragment depth, and the volume can be clipped (see §4).
  - `GroundPolylinePrimitive` uses volumes per segment.
- **CesiumJS, VectorProvider** ([#13577][ce-13577], 2026): new draping for `Buffer*Collection` and vector tiles.
  - Per globe tile, `VectorPipeline` clips segments and polygon rings into the tile's UV square, builds a grid lookup and packs them into textures.
  - The globe fragment shader evaluates the distance to segments and point-in-polygon analytically.
  - `VectorDirtyRegion` limits re-baking to the region an edit touched.
  - This is per-terrain-tile draping, like ours, but resolution-independent.
- **deck.gl `TerrainExtension`:** the extension has two modes.
  - `drape`: draped layers are rendered into a "terrain cover" texture per terrain tile (`terrain-cover.ts`), which the terrain layer overlays on its own colour. Covers are redrawn when a draped layer needs redraw.
  - `offset`: points and icons read z from one height map, which is rendered from above for the whole viewport and capped at 2048 px (`MAP_MAX_SIZE` in `height-map-builder.ts`). Its resolution therefore drops with view size.
- **MapLibre render-to-texture:** `background`, `fill`, `line`, `raster`, `hillshade` and `color-relief` layers are drawn into each terrain tile's texture (`LAYERS_TO_TEXTURES`), then the terrain mesh samples that texture. Circles and symbols are not draped: their vertex shaders sample the DEM (`get_elevation`).
- **iTowns:** `Feature2Texture` rasterizes features with a 2D canvas into one texture per tile and level (a colour layer), just like imagery.
- **OpenLayers:** 2D only, so there is no terrain draping.

### Ground clamping of markers and models

- **CesiumJS:**
  - `HeightReference.CLAMP_TO_GROUND` registers a callback with `QuadtreePrimitive.updateHeight`.
  - When a tile at a finer level loads, its callbacks run inside a time slice of 2 ms per frame (`_updateHeightsTimeSlice`), and the position jumps to the new height.
- **MapLibre:** clamping happens in the vertex shader from the DEM texture, so it always matches the drawn mesh. DOM markers are re-projected on the CPU instead.
- **deck.gl:** the `offset` mode samples the viewport height map in the vertex shader.
- **iTowns:** `Label.updateElevationFromLayer` reads `DEMUtils.getElevationValueAt` (`FAST_READ_Z`) when a node updates.

### Clustering and marker level of detail

- **supercluster:**
  - It builds a kdbush tree per zoom level, from `maxZoom` down to `minZoom`, by greedy radius merging (`radius` 40 px on an `extent` 512).
  - `getClusters(bbox, zoom)` answers per integer zoom. `getClusterExpansionZoom`, `getChildren` and `getLeaves` support navigation.
  - "Once loaded, index is immutable": an update means a full `load`.
- **MapLibre:**
  - GeoJSON sources run supercluster in the worker (`clusterRadius` 50 px, `clusterMaxZoom`, `clusterProperties` reducers).
  - Clusters change at integer zooms without animation.
- **deck.gl example** (`icon-cluster-layer.ts`): supercluster on the main thread, `getClusters` over the whole world at `Math.floor(zoom)`, with no transitions.
- **Cesium `EntityCluster`:** whenever the camera changes, it rebuilds a kdbush index of screen-space positions and merges within `pixelRange` 80 px. Clusters therefore depend on the exact camera, not on the zoom.
- **OpenLayers `Cluster` source:** a greedy pass over all features, querying the vector source's rbush with `distance` 20 px. It re-runs on every resolution change, on the main thread.

### Massive point datasets

- **Potree:**
  - An octree with a global `pointBudget` (1,000,000 by default) and a priority queue weighted by the projected screen radius of each node.
  - Nodes below `minimumNodePixelSize` are skipped, at most `maxNodesLoading` nodes load at once, and an LRU frees memory.
  - The budget caps the work per frame regardless of dataset size.
- **iTowns:** `PointCloudLayer` (Potree, EPT, COPC) uses the same scheme with `pointBudget` 2,000,000.
- **deck.gl:** flat instanced layers over binary attributes (millions of scatterplot points) with no spatial LOD. Aggregation layers (grid, hexagon, heatmap) cover density.
- **OpenLayers:** WebGL points with worker-built buffers.

### Styling

- **MapLibre:** evaluates Style Specification expressions per feature in the worker. Zoom-dependent values are interpolated per frame by uniforms.
- **OpenLayers:** compiles a subset of the same idea to GLSL.
- **deck.gl:** JS accessors with `updateTriggers`.
- **Cesium:** `Cesium3DTileStyle` for tiles, and per-property objects for entities.

## 4. Known failure modes

**Draping.**

- Cesium:
  - `GroundPrimitive`s "rendering incorrectly or disappearing at different zoom levels" ([#4161][ce-4161], [#4326][ce-4326]);
  - "volume was being clipped by the far plane" ([#3706][ce-3706]);
  - failures "when crossing the international date line" ([#6951][ce-6951]);
  - wrong rendering "on systems without the `WEBGL_depth_texture` extension" ([#4747][ce-4747]);
  - "classification artifacts on some mobile devices" ([#9108][ce-9108]);
  - wrong bounding spheres "in regions with negative terrain heights" ([#11184][ce-11184]);
  - draped vector polylines "rendering at twice their specified width" ([#13675][ce-13675]).
- MapLibre:
  - "terrain drape textures not being refreshed after zoom changes, causing stale rendering" ([#8251][ml-8251]);
  - `fill-outline-color` and fill antialiasing not drawn with terrain ([#4200][ml-4200]);
  - "raster flickering when using terrain 3D" ([#6446][ml-6446]);
  - render-to-texture preparation cost ([#7833][ml-7833], [#7863][ml-7863]).

**Clamping.**

- Cesium:
  - "height updates could stall when using high-resolution terrain due to a growing queue of tiles in `updateHeights`" ([#12476][ce-12476]);
  - callbacks "could receive positions computed for other tiles" ([#12602][ce-12602]);
  - billboards that "sink into terrain when clamped to ground" ([#6621][ce-6621]);
  - "race condition during billboard clamping when the height reference changes" ([#10191][ce-10191]);
  - improper clamping ([#4396][ce-4396], [#4062][ce-4062]);
  - "intermittent ground clamping issues for all entity types" ([#6930][ce-6930]);
  - terrain-clamped billboards mispositioned in 2D and Columbus view ([#5042][ce-5042], [#12531][ce-12531]).
- MapLibre: "markers and popups misplaced … by terrain that loads after the map settled" ([#8433][ml-8433]).
- iTowns: "catch no data elevation" ([`e1e3b1d`][it-nodata]) and "fix proj on base alti" ([`49e48b5`][it-alti]).

**Clustering.**

- Cesium:
  - "entities have not been clustered correctly" ([#13064][ce-13064]);
  - "inconsistent clustering when `dataSource.show` was toggled" ([#11560][ce-11560]);
  - "billboards not initially clustering" ([#5208][ce-5208]);
  - picking clusters "would return undefined" ([#5286][ce-5286]);
  - labels missing with clustering enabled ([#6087][ce-6087]);
  - a crash with invisible labels ([#4414][ce-4414]).
- MapLibre:
  - "stale clusters on untouched tiles" and "clustering twice" ([#8613][ml-8613]);
  - non-integer `clusterMaxZoom` "breaking clusters" ([#5929][ml-5929]);
  - "incorrect cluster radius scaling" ([#5055][ml-5055]);
  - options not "triggering recluster" ([#6603][ml-6603]).
- OpenLayers: "issue with cluster source reloading" ([#3917][ol-3917]).

**Large-dataset performance.**

- Cesium:
  - "Improved performance for billboards and labels clamped to terrain" ([#6781][ce-6781], [#6844][ce-6844]);
  - "Massively improved performance of clamped Entity ground geometry with dynamic colors" ([#8630][ce-8630]);
  - clamping that was always on "reducing performance in cases when it was unneeded" ([#4459][ce-4459]);
  - texture atlas memory with many billboards ([#172][ce-172]).
- deck.gl:
  - "Fix attribute allocation bug when using partial update with double precision" ([#3854][dg-3854]);
  - "Improve performance for `visible: false` layers" ([#7035][dg-7035]);
  - "Limit for color picking cache size" ([#5115][dg-5115]).
- Potree: "Crash related to LOD" ([#798][po-798]).

## 5. How they test and benchmark

- **CesiumJS:**
  - Jasmine specs on a real WebGL context: `GroundPrimitiveSpec` (48 cases) renders over a test globe and asserts pixel colours with `toRender` and `toPickAndCall`; `EntityClusterSpec` (16 cases).
  - No published benchmarks for these paths.
- **deck.gl:**
  - Golden-image render tests per layer (`test/render/test-cases/*.spec.ts`, including `icon-layer`, `path-layer`, `polygon-layer`, `point-cloud-layer`, `collision-filter-extension`) compared against `test/render/golden-images`.
  - Node benchmarks such as `attribute-update.bench.js` and `layer.bench.js`.
- **MapLibre:**
  - Style-driven render tests with expected images, including `terrain/` cases such as `fill-outline`, `symbol-add-terrain`, `rtt-mipmap-minification` and `skirts-none`.
  - Benchmarks for subdivision and for worker tile parsing.
- **OpenLayers:** rendering cases with reference screenshots (`webgl-points`, `webgl-points-geographic`, `heatmap-layer`) and browser specs.
- **iTowns:** Puppeteer functional tests on examples (`misc_clamp_ground.js`).
- **Potree:** no automated tests.
- **supercluster:** fixture tests and `bench.js`, which builds 1,000,000 points and reports time, allocation and peak heap.

**Lesson:** screenshot tests with a tolerance at fixed cameras are the norm. No project tests draping across terrain levels or clamping transitions over time. Nobody benchmarks frame time with clustering active.

## 6. Chosen approach and why

1. **Storage: structure of arrays per layer.**
   - Positions are float64 on the CPU, with typed columns for style outputs. A removed row is filled by moving the last row into it, so rows stay dense with no free list and a removal re-uploads one row (`packages/layers/src/feature-store.ts`).
   - Edits set per-row dirty flags that the upload coalesces into contiguous runs, and only those runs are re-uploaded (`writeBuffer` or `bufferSubData`), as with deck.gl's `startRow`/`endRow` and Cesium's new `Buffer*Collection`.
   - This avoids Cesium's object-per-item collections and the per-tile rebuilds that MapLibre's `updateData` needs. It serves F376 to F378.
2. **Points, markers and billboards:** one instanced quad per feature. Sizes are in screen pixels and the corner offsets are applied in clip space. Images come from a shelf-packed icon atlas with device-pixel-ratio-aware entries (deck.gl, Cesium). Positions go through camera-relative origins per chunk (ADR 0004), so there is no jitter at street level (F367).
3. **Polylines:** screen-space-width quads per segment with joins and caps. Segments longer than a threshold angle are subdivided geodesically on the CPU, in the worker, so they follow the ellipsoid in every phase. This is MapLibre's subdivision idea applied to data rather than tiles.
4. **Polygons:** triangulated in a worker with earcut (ISC) after geodesic subdivision of the edges and of the interior. Holes and very large polygons are supported, and the antimeridian and the poles are split before triangulation.
5. **Draping: rendered into the terrain tiles' overlay texture pass.**
   - **Mechanism:** lines and polygons are drawn in tile-local 2D into the overlay texture of each terrain tile, and the terrain shader samples it. The overlay therefore follows the relief of whatever terrain level is drawn, by construction.
   - **Same lineage:** this is the MapLibre render-to-texture and iTowns `Feature2Texture` approach, and the deck.gl `drape` mode. Cesium's 2026 VectorProvider moved to per-tile draping too.
   - **Why not shadow volumes:** Cesium's `GroundPrimitive` needs stencil, depth-texture and far-plane care and has a long bug history (§4).
   - **Why not a viewport height map:** deck.gl's `offset` height map loses resolution with view size.
   - **Caching:** overlays are cached per tile and keyed by layer version. A dirty range invalidates only the tiles its bounding box touches (like Cesium's `VectorDirtyRegion`). A tile change regenerates its overlay before the tile is shown, which avoids MapLibre #8251.
6. **Ground clamping on the CPU, with a smooth transition.**
   - **Sampling:** clamped features sample the best loaded terrain height in float64.
   - **Updates:** when a finer tile loads under them, they re-sample. The new height is reached over a short transition (about 200 ms), not a jump, which is F363 and something Cesium does not do.
   - **Bounded work:** each tile load enqueues only the features inside it (found through the layer's spatial index), and processing is time-sliced (as Cesium's 2 ms slice does). Stale results are discarded by tile identity, to avoid Cesium #12476 and #12602.
7. **Clustering with supercluster in a worker.**
   - **Index:** the worker builds every zoom level once. The layer asks for the clusters of the whole world at each integer zoom, so clusters stay fixed while panning, unlike Cesium's per-camera screen clustering, and cluster counts always add up to the number of points.
   - **Transitions:** splits and merges animate between parent and child positions, which neither MapLibre nor deck.gl does (F373). supercluster does not expose parents, so a child's parent is the nearest item of the coarser zoom within one cluster radius (a grid of radius-sized cells); clicking a cluster gives its expansion zoom and the bounds of its points.
   - **Updates:** a data update rebuilds the index in the worker, throttled, and swaps it atomically.
8. **Marker level of detail:** distant or dense markers draw as simplified symbols, such as a dot in the marker colour from the same instance buffer, and cross-fade to full markers by screen-space density and distance (F374).
9. **Styling:** MapLibre Style Specification expressions through `@maplibre/maplibre-gl-style-spec`'s evaluator (ISC), shared with vector tiles.
   - Feature-dependent results are written into the style columns.
   - Zoom-dependent interpolation is evaluated per frame for the current zoom, so there are no steps (F370).
10. **Massive points:** at 100,000 to several hundred thousand points, instancing from typed buffers plus clustering and marker LOD is enough. Potree's point budget and octree are kept for point-cloud tilesets (M13).

**Testing:**

- **Node unit tests:** the storage model (dirty-run coalescing, removal by moving the last row), the style expressions, cluster transitions (parent and child mapping), geodesic subdivision and the antimeridian split.
- **Playwright:**
  - screenshots against baselines with a tolerance for each primitive in the globe, 2D and tilted phases on both backends;
  - frame differencing during a terrain refinement sequence, to catch pops of clamped markers and draped shapes;
  - a check that draped shapes match the terrain at each forced terrain level (F364, F365).
- **Benchmarks:**
  - 100,000 clustered points while zooming, with p95 ≤ 16.7 ms (F389);
  - a 10,000-updates-per-second feed on 100,000 features (F378).

## 7. Open questions

1. **Overlay resolution:** imagery and terrain choose levels independently, so a coarse terrain tile under a fine view would blur a raster overlay. Cesium's VectorProvider evaluates vectors analytically per fragment and avoids this. Should overlays be rendered per imagery-level tile, or should line edges use an analytic distance pass? Measure line crispness at street level over coarse terrain first.
2. **GPU or CPU clamping:** MapLibre samples the DEM in the vertex shader, so clamped symbols always match the drawn mesh, with no CPU queue (avoiding the Cesium #12476 and #12602 class of bugs). The CPU path is kept because picking, labels and collision need the clamped float64 position. A GPU fallback is an option if the CPU path cannot meet F363.
3. **Re-clustering a live feed:** supercluster is immutable, so a live clustered layer at 10,000 updates per second needs throttled rebuilds. Measure the rebuild time for 100,000 points in the worker to set the interval.
4. **Draping onto 3D Tiles:** Cesium drapes on both terrain and 3D Tiles. The overlay approach covers terrain only; draping onto buildings is left to the vector and 3D Tiles survey (M13).

[ce]: https://github.com/CesiumGS/cesium/tree/0c09769c7570131fef452e2af1688538ca383917
[ce-13212]: https://github.com/CesiumGS/cesium/pull/13212
[ce-13590]: https://github.com/CesiumGS/cesium/issues/13590
[ce-13577]: https://github.com/CesiumGS/cesium/pull/13577
[ce-13675]: https://github.com/CesiumGS/cesium/pull/13675
[ce-4161]: https://github.com/CesiumGS/cesium/issues/4161
[ce-4326]: https://github.com/CesiumGS/cesium/issues/4326
[ce-3706]: https://github.com/CesiumGS/cesium/issues/3706
[ce-6951]: https://github.com/CesiumGS/cesium/issues/6951
[ce-4747]: https://github.com/CesiumGS/cesium/pull/4747
[ce-9108]: https://github.com/CesiumGS/cesium/pull/9108
[ce-11184]: https://github.com/CesiumGS/cesium/pull/11184
[ce-12476]: https://github.com/CesiumGS/cesium/issues/12476
[ce-12602]: https://github.com/CesiumGS/cesium/issues/12602
[ce-6621]: https://github.com/CesiumGS/cesium/pull/6621
[ce-10191]: https://github.com/CesiumGS/cesium/issues/10191
[ce-4396]: https://github.com/CesiumGS/cesium/issues/4396
[ce-4062]: https://github.com/CesiumGS/cesium/issues/4062
[ce-6930]: https://github.com/CesiumGS/cesium/pull/6930
[ce-5042]: https://github.com/CesiumGS/cesium/issues/5042
[ce-12531]: https://github.com/CesiumGS/cesium/issues/12531
[ce-13064]: https://github.com/CesiumGS/cesium/pull/13064
[ce-11560]: https://github.com/CesiumGS/cesium/pull/11560
[ce-5208]: https://github.com/CesiumGS/cesium/pull/5208
[ce-5286]: https://github.com/CesiumGS/cesium/issues/5286
[ce-6087]: https://github.com/CesiumGS/cesium/issues/6087
[ce-4414]: https://github.com/CesiumGS/cesium/issues/4414
[ce-6781]: https://github.com/CesiumGS/cesium/pull/6781
[ce-6844]: https://github.com/CesiumGS/cesium/pull/6844
[ce-8630]: https://github.com/CesiumGS/cesium/pull/8630
[ce-4459]: https://github.com/CesiumGS/cesium/pull/4459
[ce-172]: https://github.com/CesiumGS/cesium/issues/172
[dg]: https://github.com/visgl/deck.gl/tree/ce528a4074ee813ac4f6b9b0e7976935519ac3f7
[dg-8153]: https://github.com/visgl/deck.gl/pull/8153
[dg-3854]: https://github.com/visgl/deck.gl/pull/3854
[dg-7035]: https://github.com/visgl/deck.gl/pull/7035
[dg-5115]: https://github.com/visgl/deck.gl/pull/5115
[ml]: https://github.com/maplibre/maplibre-gl-js/tree/49f780a03846d1d810316c3a5b5446617e197e94
[ml-8251]: https://github.com/maplibre/maplibre-gl-js/issues/8251
[ml-4200]: https://github.com/maplibre/maplibre-gl-js/issues/4200
[ml-6446]: https://github.com/maplibre/maplibre-gl-js/pull/6446
[ml-7833]: https://github.com/maplibre/maplibre-gl-js/pull/7833
[ml-7863]: https://github.com/maplibre/maplibre-gl-js/pull/7863
[ml-8433]: https://github.com/maplibre/maplibre-gl-js/pull/8433
[ml-8613]: https://github.com/maplibre/maplibre-gl-js/pull/8613
[ml-5929]: https://github.com/maplibre/maplibre-gl-js/issues/5929
[ml-5055]: https://github.com/maplibre/maplibre-gl-js/pull/5055
[ml-6603]: https://github.com/maplibre/maplibre-gl-js/pull/6603
[ol]: https://github.com/openlayers/openlayers/tree/73c527cd47863d526fee5e50ccec9831082e61b7
[ol-9562]: https://github.com/openlayers/openlayers/pull/9562
[ol-10016]: https://github.com/openlayers/openlayers/pull/10016
[ol-3917]: https://github.com/openlayers/openlayers/pull/3917
[it]: https://github.com/iTowns/itowns/tree/d6ee3549bfaf83ebe79d039337e73155227b7d64
[it-nodata]: https://github.com/iTowns/itowns/commit/e1e3b1d4b3eac3ff122d1e0769c0d5d377440d1a
[it-alti]: https://github.com/iTowns/itowns/commit/49e48b5c4ac7c27e9676fdfa0b3a37f7a301630b
[po]: https://github.com/potree/potree/tree/5636cd471d9eb464969e758be45c44d7613d3859
[po-798]: https://github.com/potree/potree/issues/798
[sc]: https://github.com/mapbox/supercluster/tree/641713a579c6bdbc5b588ac8a61b1552ccb21311
[kd]: https://github.com/mourner/kdbush/tree/cc2c28592c23a2d2542a5670fbdd1fbec32535dd
[rb]: https://github.com/mourner/rbush/tree/e59712716a84dda2e31f9b471b32faa178d8056f
