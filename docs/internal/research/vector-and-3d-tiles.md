# Vector tiles, buildings and 3D Tiles

- Status: Complete (survey for M13)
- Date: 2026-10-22
- Decision: [ADR 0041](../adr/0041-vector-tiles-and-3d-tiles.md)

## 1. Scope and requirements

This survey covers Mapbox Vector Tile (MVT) decoding and tessellation, style evaluation, symbol placement on vector tiles, building extrusion, and OGC 3D Tiles traversal, refinement and caching. Label collision and fading in general are in the [labels survey](labels.md), request scheduling in [scheduling-and-caching.md](scheduling-and-caching.md), compressed content in [compression.md](compression.md); they are referred to, not repeated.

PLAN.md requirements it serves:

- **Glitch-free rendering:** no seams at tile edges, no label flicker or duplicates, no z-fighting of buildings, no holes while 3D Tiles stream.
- **Vector tiles, buildings and 3D Tiles (M13):** MVT on the globe, the flat map and through the morph; MapLibre styles without edits; OpenStreetMap buildings at real height; 3D Tiles 1.0 and 1.1 streamed by screen-space error.
- **Fixed constraints:** no servers (tiles, glyphs and sprites are hosted by the consumer, ADR 0015), permissive third-party licenses only, `core` without runtime dependencies.
- **Engineering standards:** decoding and tessellation in workers, memory within budget, visual behavior proved by browser tests.
- **Feature list:** F439 (this survey) and F440–F472.

## 2. Projects studied

| Project           | Version / commit                              | License         | Files read                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------- | --------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MapLibre GL JS    | 6.15.0, `main` [`d7ab82b`][ml]                | BSD-3-Clause    | `src/data/bucket/{fill,line,fill_extrusion,symbol}_bucket.ts`, `src/data/{load_geometry,extent_bounds}.ts`, `src/tile/{tile_manager,tile_cache}.ts` (retain and overzoom), `src/source/vector_tile_overzoomed.ts`, `src/symbol/{cross_tile_symbol_index,shaping,get_anchors}.ts` (skimmed), `src/webgl/draw/draw_fill_extrusion.ts`, `package.json`, render-test and benchmark lists, `CHANGELOG.md` |
| MapLibre Native   | core 5.4.0 (Android 13.7.1), [`d2efacc`][mn]  | BSD-2-Clause    | `src/mln/renderer/buckets/{fill,fill_extrusion,line}_bucket.cpp`, `src/mln/tile/` (file list), `CHANGELOG.md`, `platform/android/CHANGELOG.md`                                                                                                                                                                                                                                                       |
| Tangram           | 0.22.0, [`f24f47c`][tg] (last commit 2024-12) | MIT             | `src/builders/{common,polygons,polylines}.js`, `git log` (no changelog)                                                                                                                                                                                                                                                                                                                              |
| OpenLayers        | 10.11.1-dev, [`73c527c`][ol]                  | BSD-2-Clause    | `src/ol/renderer/canvas/VectorTileLayer.js` (source tiles, clipping), `changelog/*.md`                                                                                                                                                                                                                                                                                                               |
| deck.gl           | 9.4.0-beta.4, [`876a1f6`][dg]                 | MIT             | `modules/geo-layers/src/mvt-layer/mvt-layer.ts`, `modules/geo-layers/src/tile-3d-layer/tile-3d-layer.ts`, `modules/geo-layers/src/tileset-2d/tileset-2d.ts` (refinement strategies), `CHANGELOG.md`                                                                                                                                                                                                  |
| CesiumJS          | 1.146.0, [`13dfa62`][ce]                      | Apache-2.0      | `packages/engine/Source/Scene/{Cesium3DTilesetBaseTraversal,Cesium3DTilesetCache}.js`, `Cesium3DTile.js` (`getScreenSpaceError`, `updatePriority`), `Cesium3DTileset.js` (options, `cancelOutOfViewRequests`), `Specs/Data/Cesium3DTiles/Tilesets/` (list), `CHANGES.md`                                                                                                                             |
| 3DTilesRendererJS | 0.5.3, [`56789f3`][tr]                        | Apache-2.0      | `src/core/renderer/tiles/{traverseFunctions,TilesRendererBase}.js`, `src/core/renderer/utilities/{LRUCache,PriorityQueue,DownloadPriorityQueue}.js`, `test/core/` (list), `TESTCASES.md`, `CHANGELOG.md`                                                                                                                                                                                             |
| iTowns            | 2.46.0, [`d6ee354`][it]                       | CeCILL-B or MIT | `packages/Main/src/Layer/{OGC3DTilesLayer,C3DTilesLayer}.js`, `packages/Main/src/Process/3dTilesProcessing.js`, `changelog.md`                                                                                                                                                                                                                                                                       |
| loaders.gl        | 5.0.0-alpha.13, [`1464ee8`][lg]               | MIT             | `modules/tiles-3d/src/tileset-3d/common/{tileset-3d,tileset-traverser,tileset-cache,tile-3d}.ts`, `modules/tiles-3d/src/tileset-3d/helpers/{tiles-3d-lod,frame-state}.ts`, `modules/tiles/src/mvt/` (file list), `CHANGELOG.md`                                                                                                                                                                      |

Only open-source projects were studied; no restrictively licensed source-available project (for example Mapbox GL JS v2 and later) was read. Mapbox GL JS and Mapbox GL Native issue links below come from the pre-fork entries of the MapLibre changelogs (the BSD-licensed v1 era) and were not followed into their code. No code was copied: the notes describe approaches, and the implementation is original.

Libraries checked: `@maplibre/maplibre-gl-style-spec` 26.4.4 (ISC; MapLibre GL JS itself depends on `^26.4.4`), `earcut` 3.2.4 (ISC), `@mapbox/vector-tile` 3.0.0 (BSD-3-Clause) and `pbf` 5.1.2 (BSD-3-Clause), the versions in MapLibre's `package.json`.

## 3. How each project solves it

### Vector tiles

**MapLibre GL JS.**

- **Decoding:** in workers with `@mapbox/vector-tile` over `pbf`; coordinates are scaled to an 8192 extent and clamped to int16, with a warning "Geometry exceeds allowed extent, reduce your vector tile buffer size" (`load_geometry.ts`).
- **Fills:** `classifyRings` (from the style-spec package) groups rings into polygons and keeps at most 500 holes, then `earcut` triangulates; on the globe, `subdividePolygon` adds vertices so long edges follow the curvature.
- **Lines:** stroke tessellation in tile units: miter, bevel, `flipbevel` (miter too long), round and `fakeround` (pie slices when the round limit is exceeded) joins; butt, square and round caps; corners sharper than 75° are split 15 px from the vertex. Line distance for dashes and gradients is packed into a few vertex bits (`MAX_LINE_DISTANCE`); when it overflows the line restarts its distance. Lines are not clipped in the worker: geometry runs into the tile buffer and each tile is drawn through a stencil clipping mask (`clipping_mask` shaders), so a cap at the tile edge lies outside the mask.
- **Extrusions:** roofs by earcut, walls per ring edge; edges lying on the clip lines outside the tile are skipped (`isBoundaryEdge`), rings entirely outside the tile are dropped (`isEntirelyOutside`), so the neighbor tile draws the wall. Opaque extrusions draw with depth test `LEQUAL`; translucent ones first draw a depth-only pass with color disabled, then the color pass, so only the nearest surface is visible.
- **Tile selection:** for each ideal tile without data the manager retains its loaded children (up to `maxOverzooming` generations) or the nearest loaded parent; past the source's `maxzoom` tiles are overzoomed by slicing the parent tile's features (`vector_tile_overzoomed.ts`); tiles out of view go to a `TileCache` sized from the viewport.
- **Style:** `@maplibre/maplibre-gl-style-spec` provides validation, expressions, legacy filter conversion and feature-state; layout properties and data-driven paint properties are evaluated per feature in the worker while buckets are built.
- **Symbols:** shaping in `shaping.ts` (balanced line breaking with ideographic break opportunities, vertical text, bidi through a plugin); anchors along lines every `symbol-spacing` with a `check_max_angle` test; the `CrossTileSymbolIndex` matches the same label across zoom levels by key and position rounded to `512 / EXTENT / 2` in a `KDBush` index; collision and 300 ms fades as described in [labels.md](labels.md).

**MapLibre Native.** The same buckets in C++ with `earcut.hpp`; `limitHoles(polygon, 500)`; a polygon beyond 65,535 vertices throws `GeometryTooLongException` (16-bit indices).

**Tangram.** Polygons with `earcut`; extrusion with `height` and `min_height`; lines built in the worker with joins, caps and a miter limit. Segments that lie along the tile edge (within `tile_edge_tolerance`) are dropped for outlines and for extruded walls (`remove_tile_edges`, `outsideTile`), which removes the seam line that clipped polygon outlines would otherwise draw. Proxy tiles (parents or children shown while loading) are masked with the stencil buffer "to avoid overlap/flicker from compounding alpha" (commit [`b82881d`][tgb82881d]).

**OpenLayers.** A render tile is composed from one or more source tiles and replayed with Canvas 2D; each executor group is clipped to the shared tile extent unless a single source tile covers it. While mixed zoom levels are shown, lower-resolution tiles are clipped to the area not covered by higher-resolution ones (`clipTileContext_`, rectangle subtraction), which fixed gaps between tiles of different resolutions ([#5890][ol5890]). Decluttering is one global `rbush` pass per frame.

**deck.gl.** `MVTLayer` uses loaders.gl's worker `MVTWorkerLoader` with binary output and draws each tile with sublayers; tile edges are clipped in the fragment shader by `ClipExtension`, but only for the Web Mercator viewport ("Rectangular common-space clipping is only valid for the Mercator target"). `Tileset2D` offers `best-available` (placeholders from ancestors or children), `no-overlap` and `never` refinement, at most 6 concurrent requests by default.

### Buildings

None of the studied engines reads OpenStreetMap tags itself: MapLibre and Tangram extrude from `height` and `min_height` attributes that the tile schema already computed (`render_height`, `render_min_height` in OpenMapTiles-style schemas), with heights in meters on the Mercator plane. MapLibre adds `fill-extrusion-vertical-gradient` and, recently, `fill-extrusion-rounded-corner-distance`, whose corners created by tile clipping are left sharp ([#8153][ml8153]). Building parts, `building:levels` and type-based defaults are left to the tile producer.

### 3D Tiles

**CesiumJS.**

- **SSE:** `geometricError × drawingBufferHeight / (distance × sseDenominator)`, with `sseDenominator = 2 tan(fovy / 2)`; orthographic and 2D modes use `geometricError / pixelSize`. Optional reductions: `dynamicScreenSpaceError` (fog-like falloff at street-level horizon views), foveated SSE (relaxed outside a screen-center cone) and `progressiveResolutionHeightFraction` (a quick low-resolution pass first).
- **Base traversal:** depth-first; a REPLACE tile refines only when all its children are loaded (`updateAndPushChildren`: "For traditional replacement refinement only refine if all children are loaded"); invisible children are still loaded when they are needed before the parent can refine; empty tiles are exempt "since it looks better if children stream in as they are loaded" and are checked with an empty traversal down to their nearest content. ADD tiles are always selected with their children. Children are sorted by distance for early-z. `skipLevelOfDetail` (skip traversal) is off by default.
- **Priority:** one number per tile combining digits for flight preload, foveated deferral, foveated factor, progressive resolution, distance or SSE, and depth; a common ancestor holds the priority of its nearest descendant so siblings load together.
- **Requests and cache:** requests are issued after traversal, sorted by priority; requests for tiles not touched this frame are cancelled (`cancelOutOfViewRequests`); `cullRequestsWhileMoving` skips tiles likely out of view on arrival. The cache is a linked list with a sentinel: tiles touched this frame move right of the sentinel, and tiles left of it are unloaded LRU-first while memory exceeds `cacheBytes` (512 MiB); `maximumCacheOverflowBytes` (512 MiB) allows more when the current view needs it ([#11310][ce11310]).

**3DTilesRendererJS.** The core (`src/core`) is renderer-agnostic and shared by the three.js and Babylon.js front ends; iTowns uses it.

- **Traversal** (`traverseFunctions.js`): mark used tiles by error against `errorTarget` (16 px default), mark visible tiles, then toggle; a REPLACE parent stays displayed until all used children are ready (`allChildrenReady`), and `loadSiblings` (default on) loads off-screen siblings so the parent can be replaced; tiles with external tileset JSON or no content "unconditionally refine". Additive children are filtered with the parent's geometric error to avoid loading too many.
- **Queues:** shared `PriorityQueue`s for download (6 jobs), parse and node processing, sorted by error then distance, or by in-frustum, unrenderable content and distance; each load carries an `AbortController` that is aborted when the tile leaves the cache ("Remove 'loadIndex' fields for cancelling redundant loads in favor of an abort signal").
- **Cache:** `LRUCache` with item limits (min 6,000, max 8,000) and byte limits (min 0.3 GB, max 0.4 GB); when full, unused items are evicted 5% at a time (`unloadPercent`), ordered by `unloadPriorityCallback`; new loads are refused while the cache is full (`stats.refused`).

**iTowns.** The legacy `C3DTilesLayer` had its own traversal (`camera._preSSE × geometricError / distance`, removal of unused tiles after `cleanupDelay`); it is deprecated ([`cbfd1bb`][itcbfd1bb]) in favor of `OGC3DTilesLayer`, which delegates traversal, loading and caching to 3DTilesRendererJS with a shared 1 GB `lruCache`.

**loaders.gl.** `Tileset3D` ports CesiumJS's base and skip traversals and the sentinel cache to TypeScript; `sseDenominator = 2 tan(fovy / 2)` (a recent fix "derive perspective screen-space error from camera field of view"), `maximumScreenSpaceError` 8, up to 64 concurrent requests. When memory exceeds `cacheBytes + maximumCacheOverflowBytes` the SSE threshold grows by 2% per frame and shrinks back by 2% below `cacheBytes`, with a dead band "preventing rapid load/evict oscillation" (`memoryAdjustedScreenSpaceError`). deck.gl's `Tile3DLayer` is a thin layer over it.

## 4. Trade-offs

| Choice                     | Options seen                                                                                                                                      | Trade-off                                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tile edge handling         | Geometry into the buffer plus stencil mask per tile (MapLibre, Tangram proxies), fragment clip (deck.gl, Mercator only), Canvas clip (OpenLayers) | Stencil masks are exact and projection-independent but cost a stencil pass per tile; a fragment clip in common space breaks on the globe; clipping in tile-local coordinates works in every projection. |
| Edge artifacts             | Skip walls and outlines along clip lines (MapLibre `isBoundaryEdge`, Tangram `remove_tile_edges`)                                                 | Required in any approach: a clipped polygon's outline or wall along the cut is not part of the feature.                                                                                                 |
| Line tessellation          | CPU stroke mesh in the worker (all GL engines), Canvas strokes (OpenLayers)                                                                       | CPU meshes keep joins exact at any zoom within a tile; distance precision limits dashes on long lines (MapLibre's packed distance).                                                                     |
| Placeholders while loading | Parents or children retained (MapLibre, deck.gl `best-available`), none (`never`)                                                                 | Retaining avoids holes; mixed levels need masking where they overlap, or translucent layers double-blend.                                                                                               |
| 3D Tiles refinement        | Base traversal: parent until all children ready (Cesium, 3DTilesRendererJS, loaders.gl); skip LOD (Cesium, off by default)                        | Base traversal never shows holes but loads more data; skip LOD loads less, needs stencil tricks and shows mixed detail.                                                                                 |
| 3D Tiles memory            | Byte budget with LRU and overflow (Cesium), item and byte limits with refusal (3DTilesRendererJS), SSE raised under pressure (loaders.gl)         | A hard budget can evict tiles still needed (holes) or stall loads; an overflow window or a growing SSE degrade detail instead of leaving holes.                                                         |
| Own code versus library    | Own traversal (Cesium, loaders.gl), library (iTowns moved to 3DTilesRendererJS, deck.gl uses loaders.gl)                                          | A library brings its scheduler, cache and, for 3DTilesRendererJS, three.js-shaped content handling; own code integrates with the engine scheduler and renderer.                                         |

## 5. Known failure modes

- **Seams and geometry at tile edges:** "a grid of lines along tile borders in line layers of sliced overzoomed tiles when the source tile extent is larger than 4096" ([#8705][ml8705]); "geometry beyond tile borders being rendered" ([#4868][ml4868]), also with terrain ([#5746][ml5746]); "line distances breaking gradient across tile boundaries" ([mapbox #9220][mb9220]); extrusion corner spikes from clipped corners ([#8153][ml8153]); OpenLayers gaps between tiles of different resolutions ([#5890][ol5890]) and hit detection beyond tile boundaries ([#17423][ol17423]); deck.gl "seams between tiles in RasterTileLayer" ([#9286][dg9286]); Tangram double blending of overlapping proxy tiles ([`b82881d`][tgb82881d]) and flicker when changing scroll direction ([`45467d1`][tg45467d1]).
- **Tessellation:** "Update earcut to v2.2.0 to fix polygon tessellation errors" ([mapbox #8772][mb8772]); vertex-count limits (Native `GeometryTooLongException`, the 500-hole limit in both MapLibres).
- **Label flicker and duplicates at tile boundaries:** "symbol-sort-key was not used for collisions that crossed tile boundaries" ([mapbox #9054][mb9054]); "labels slipping/cropping at tile bounds" ([mapbox #757][mb757]); "missing labels when zooming out from overzoomed tile" ([mapbox #5827][mb5827]); "symbol fading across tile reloads" ([mapbox #5491][mb5491]); Native "symbols flickered when zooming out" ([#16][mn16]); "Fixes line flickering problem" ([#5094][ml5094]); fill and line layers flickering on zoom ([mapbox-gl-native #12982][mbn12982]). More in [labels.md](labels.md).
- **Extrusion z-fighting and shading:** "Fix z-fighting on overlapping fills within the same layer" ([mapbox #3320][mb3320]); "Fix layer z-fighting" ([mapbox-gl-native #9942][mbn9942]); Cesium "flickering artifacts with 3D Tiles tilesets with thin walls" ([#5940][ce5940]); walls facing exactly east or west shaded brighter ([#8604][ml8604]); vertical gradient lost over terrain ([#8410][ml8410]); Native wall lighting on rotated maps ([#4662][mn4662]).
- **3D Tiles holes and mixed detail:** "empty tiles would be selected instead of their nearest loaded ancestors" ([#7011][ce7011]); "replacement refinement when leaf is empty" ([#8996][ce8996]); mixed level of detail when an external tileset was visible but its root was not ([#7099][ce7099]) and external tilesets not traversed to their root ([#7035][ce7035]); traversal bugs with additive refinement ([#5766][ce5766]) and with `skipLevelOfDetail` off ([#5869][ce5869]); more robust REPLACE for vector data tilesets ([#13686][ce13686]). loaders.gl: "Remove rendering flicker by holding refined tile" ([#3311][lg3311]), "Refine empty tiles" ([#3293][lg3293]), empty traversal aligned with CesiumJS for "low-res flickering" ([#2847][lg2847]), implicit tiling and subtree parsing fixes ([#2823][lg2823], [#2549][lg2549]). 3DTilesRendererJS 0.5.x: tiles "getting 'stuck' visible during traversal", unconditional traversal fixes, implicit tiling with an external availability buffer. iTowns: "tiles disappearing when zooming in and out" ([`c04e784`][itc04e784]).
- **Memory growth:** Cesium "3D Tiles requests were being unintentionally retained after the requests were cancelled" ([#8843][ce8843]) and the replacement of `maximumMemoryUsage` by `cacheBytes` plus overflow ([#11310][ce11310]); 3DTilesRendererJS `unloadUnusedContent` "looping forever when fractional byte sizes cause the tracked total to drift" and a plugin retaining tile references; MapLibre "unbounded memory growth caused by failure to cancel requests to the cache" ([mapbox #8472][mb8472]), a leak where an aborted worker request left its promise pending ([#7826][ml7826]), typed array views retaining buffers after upload ([#7280][ml7280]), GeoJSON memory growing when `setData` outpaces the worker ([#8585][ml8585]).

## 6. How they test and benchmark

- **MapLibre GL JS:** 195 render-test groups with expected PNGs, among them 11 `fill-extrusion-*` groups, `line-join/*` and `line-cap/*` (including `*-transparent` cases that catch double blending at joins), `extent/*` (1024 and 65536 extents, overzoomed lines), `text-tile-edge-clipping/*` and 117 `regressions/*` cases named after issues. Vitest benchmarks: `worker_tile.bench.ts` (decode and bucket a real tile), `subdivision.bench.ts`, `validate_style.bench.ts`, `style_layer.bench.ts`, `properties.bench.ts`, `placement`, `collision_index`, `symbol_layout`, `cross_tile_symbol_index`.
- **MapLibre Native:** the same render tests and expectations, with per-platform metrics.
- **CesiumJS:** Jasmine specs (`Cesium3DTilesetSpec`, `Cesium3DTileSpec`, `ImplicitSubtreeSpec` and other `Implicit*Spec`) on small fixture tilesets that each isolate one case: `TilesetEmptyRoot`, `TilesetEmptyExternal`, `TilesetRefinementMix`, `TilesetReplacement1`–`3`, `TilesetWithViewerRequestVolume`, `TilesetSubtreeExpiration`, `TilesetWithTransforms`, `TilesetPoints`; `Cesium3DTilesetSpec` checks selected tiles, pending requests and memory use after camera moves.
- **3DTilesRendererJS:** unit tests for `traverseFunctions`, `TilesRendererBase`, `LRUCache`, `PriorityQueue`, `DownloadPriorityQueue`; `TESTCASES.md` lists manual checks ("Verify all sibling tiles load", active tiles with updates disabled).
- **deck.gl and loaders.gl:** render tests on stored MVT tiles (`test/data/mvt-tiles`) and a fixture `tileset.json`; loaders.gl has an MVT benchmark.
- **OpenLayers:** rendering cases compared to expected images.

No project tests the absence of holes or seams across real frames of motion: they compare single frames, and the 3D Tiles suites check selection state, not pixels.

## 7. Chosen approach and why

1. **Style evaluation and validation:** `@maplibre/maplibre-gl-style-spec` 26.4.4 (ISC), pinned to 26.x, the package MapLibre GL JS itself depends on, so semantics match by construction (F444–F451). `validateStyleMin` reports errors with JSON paths and invalid layers are skipped; `featureFilter` evaluates filters (legacy filters converted); `createPropertyExpression` evaluates paint and layout properties, zoom and data-driven, with feature-state. Writing an expression engine would duplicate the most tested part of the ecosystem.
2. **Tessellation in workers:** polygons with `earcut` (ISC), as every GL engine does; lines by our own original stroke tessellation (miter, bevel and round joins with a miter limit, butt, square and round caps, line distance for dashes, kept in float32 per feature rather than packed bits). Geometry is clipped to the tile extent plus a small buffer in the worker; at draw, fragments are clipped at the exact tile edge in tile-local coordinates, which, unlike deck.gl's common-space clip, works on the globe and through the morph; caps are not generated at clipped endpoints, and polygon outlines and extrusion walls along clip lines are skipped (MapLibre and Tangram both had to). Parents and children shown as placeholders are clipped to the area the ideal tiles do not cover, so translucent layers never double-blend (Tangram, OpenLayers).
3. **Text shaping:** our own small shaper over the SDF glyph-range metrics: glyph PBF ranges from the style's `glyphs` URL, requested only for the ranges of code points in use; line breaking at `text-max-width` with ideographic break opportunities, justification, anchors and letter spacing. RTL and complex scripts are a follow-up (MapLibre itself needs a plugin for bidi).
4. **Label placement:** point labels and line labels (anchors along lines every `symbol-spacing`, rejected beyond `text-max-angle`), collision in the existing `rbush` index with priorities (`symbol-sort-key`, then layer order), cross-tile deduplication by label key and world position quantized at the tile's zoom (MapLibre's `CrossTileSymbolIndex` idea), fades over 300 ms, reusing the M10 placement ([labels.md](labels.md)). Sort keys apply across tiles, never per tile ([mapbox #9054][mb9054]).
5. **Buildings:** roofs by earcut and walls from footprint rings; height from `height` or `render_height`, base from `min_height`, else `building:levels × 3 m`, else a documented default-height table by building type (F456); building parts hide their parent outline (OSM Simple 3D Buildings). Translucent buildings use a depth prepass as MapLibre does, opaque ones the reversed-Z float depth of ADR 0005, so walls of adjacent buildings and the ground do not z-fight. On the flat map heights are scaled by the projection's scale factor (F458). The studied engines leave tag interpretation to the tile schema; our pipeline produces the tiles, so either side can compute it (open question 3).
6. **3D Tiles parsing:** our own parser for tileset JSON 1.0 and 1.1, b3dm, i3dm, pnts and cmpt headers with feature and batch tables, glTF handed to the engine's glTF loader, implicit tiling with subtree availability, and the metadata schema, instead of loaders.gl's stack, which brings its own scheduler, cache and loader framework that would duplicate the engine's (scheduling-and-caching survey).
7. **3D Tiles traversal:** SSE = geometricError × viewportHeight / (2 × distance × tan(fovY / 2)), the formula all three studied traversals converge on. REPLACE keeps the parent until all children, including off-screen siblings, are loaded (Cesium's base traversal and 3DTilesRendererJS); ADD draws parent and children; empty tiles and external tilesets refine unconditionally, with an empty traversal down to the nearest content so empty leaves never leave holes ([#7011][ce7011], [#8996][ce8996]). Request priority by SSE and distance to the screen center; LRU eviction within a byte budget, never of tiles selected this frame (Cesium's sentinel rule); requests no longer needed are cancelled and their buffers released ([#8843][ce8843]). Fixture tilesets in the style of Cesium's (empty root, empty external, refinement mix, implicit) drive Node tests of the traversal; browser tests count holes over a scripted flight (F471).

## 8. Open questions

1. **Own traversal versus 3DTilesRendererJS (moderate evidence against):** iTowns abandoned its own traversal for 3DTilesRendererJS's renderer-agnostic core (Apache-2.0), and CLAUDE.md prefers maintained libraries. Reasons to keep our own: the library's queues and `LRUCache` are shared singletons that would bypass the engine scheduler and memory budget (F462), its frustum and SSE live in the three.js subclass, and its package declares three.js, Babylon.js and React peer dependencies. Revisit if the traversal's fixture tests show repeated bugs of the kinds listed above.
2. **Budget pressure:** a strict byte budget can evict tiles the view needs. Options: Cesium's overflow window or loaders.gl's SSE raised by 2% per frame under pressure with a dead band. Proposal: overflow window first (simplest, no detail oscillation), measured in F471.
3. **Building tags in the pipeline or the engine:** heights from `building:levels` and type defaults can be computed when tiles are built (as OpenMapTiles-style schemas do with `render_height`) or at runtime. Runtime is required for third-party tiles that carry raw tags; the pipeline can precompute for our own extract.
4. **Line distance precision:** float32 distance per feature avoids MapLibre's packed-bit overflow but loses dash precision on very long lines; check dashes on the longest motorway in the fixture extract.
5. **Skip LOD:** not adopted; Cesium keeps it off by default and it is the source of mixed-detail bugs. Revisit only if F471's load times miss budget.

[ml]: https://github.com/maplibre/maplibre-gl-js/tree/d7ab82bcd11dd7391807acfee14747f7dc66a096
[mn]: https://github.com/maplibre/maplibre-native/tree/d2efacc09fcf888a5e76f8eede4268aa23483765
[tg]: https://github.com/tangrams/tangram/tree/f24f47cdfa825fb4d20b639730ce2f384e2e76c4
[ol]: https://github.com/openlayers/openlayers/tree/73c527cd47863d526fee5e50ccec9831082e61b7
[dg]: https://github.com/visgl/deck.gl/tree/876a1f6210b7120160d41cbe5bb805e5f9ef7887
[ce]: https://github.com/CesiumGS/cesium/tree/13dfa62dcd10f17f0b695d48a1933e9520875e47
[tr]: https://github.com/NASA-AMMOS/3DTilesRendererJS/tree/56789f3f6613c9d63ebbbc2e8967a5077b4ba666
[it]: https://github.com/iTowns/itowns/tree/d6ee3549bfaf83ebe79d039337e73155227b7d64
[lg]: https://github.com/visgl/loaders.gl/tree/1464ee8e912521b658a51f96c88c3b2310ceb2cd
[ml4868]: https://github.com/maplibre/maplibre-gl-js/pull/4868
[ml5094]: https://github.com/maplibre/maplibre-gl-js/pull/5094
[ml5746]: https://github.com/maplibre/maplibre-gl-js/pull/5746
[ml7280]: https://github.com/maplibre/maplibre-gl-js/pull/7280
[ml7826]: https://github.com/maplibre/maplibre-gl-js/pull/7826
[ml8153]: https://github.com/maplibre/maplibre-gl-js/issues/8153
[ml8410]: https://github.com/maplibre/maplibre-gl-js/pull/8410
[ml8585]: https://github.com/maplibre/maplibre-gl-js/pull/8585
[ml8604]: https://github.com/maplibre/maplibre-gl-js/pull/8604
[ml8705]: https://github.com/maplibre/maplibre-gl-js/pull/8705
[mb757]: https://github.com/mapbox/mapbox-gl-js/issues/757
[mb3320]: https://github.com/mapbox/mapbox-gl-js/issues/3320
[mb5491]: https://github.com/mapbox/mapbox-gl-js/issues/5491
[mb5827]: https://github.com/mapbox/mapbox-gl-js/issues/5827
[mb8472]: https://github.com/mapbox/mapbox-gl-js/pull/8472
[mb8772]: https://github.com/mapbox/mapbox-gl-js/pull/8772
[mb9054]: https://github.com/mapbox/mapbox-gl-js/pull/9054
[mb9220]: https://github.com/mapbox/mapbox-gl-js/pull/9220
[mn16]: https://github.com/maplibre/maplibre-native/issues/16
[mn4662]: https://github.com/maplibre/maplibre-native/pull/4662
[mbn9942]: https://github.com/mapbox/mapbox-gl-native/pull/9942
[mbn12982]: https://github.com/mapbox/mapbox-gl-native/pull/12982
[tgb82881d]: https://github.com/tangrams/tangram/commit/b82881dc247820a076adaa4d62cb89c62e7a460c
[tg45467d1]: https://github.com/tangrams/tangram/commit/45467d1bfd0bbf5707153ee08018fa1bf787c1a6
[ol5890]: https://github.com/openlayers/openlayers/pull/5890
[ol17423]: https://github.com/openlayers/openlayers/pull/17423
[dg9286]: https://github.com/visgl/deck.gl/pull/9286
[ce5766]: https://github.com/CesiumGS/cesium/issues/5766
[ce5869]: https://github.com/CesiumGS/cesium/issues/5869
[ce5940]: https://github.com/CesiumGS/cesium/pull/5940
[ce7011]: https://github.com/CesiumGS/cesium/pull/7011
[ce7035]: https://github.com/CesiumGS/cesium/pull/7035
[ce7099]: https://github.com/CesiumGS/cesium/pull/7099
[ce8843]: https://github.com/CesiumGS/cesium/pull/8843
[ce8996]: https://github.com/CesiumGS/cesium/pull/8996
[ce11310]: https://github.com/CesiumGS/cesium/pull/11310
[ce13686]: https://github.com/CesiumGS/cesium/issues/13686
[lg2549]: https://github.com/visgl/loaders.gl/pull/2549
[lg2823]: https://github.com/visgl/loaders.gl/pull/2823
[lg2847]: https://github.com/visgl/loaders.gl/pull/2847
[lg3293]: https://github.com/visgl/loaders.gl/pull/3293
[lg3311]: https://github.com/visgl/loaders.gl/pull/3311
[itc04e784]: https://github.com/iTowns/itowns/commit/c04e784
[itcbfd1bb]: https://github.com/iTowns/itowns/commit/cbfd1bb
