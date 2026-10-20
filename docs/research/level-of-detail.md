# Terrain and imagery levels of detail

Survey for milestones M3 (imagery streaming) and M4 (terrain). Decision: [ADR 0006](../adr/0006-level-of-detail.md).

## 1. Scope and requirements

How a globe engine chooses which terrain and imagery tiles to draw, what it draws while better tiles load, how it moves between levels without popping, and how it keeps tile edges, poles and the antimeridian free of cracks, seams and holes. Covered: quadtrees, screen-space error (SSE), chunked LOD, geometry clipmaps, geomorphing, skirts versus stitching, RTIN and Delaunay meshes (Martini, Delatin), parent fallback, cross-fade, imagery draped on terrain at independent levels, poles and antimeridian. Request priorities, caches and eviction belong to the scheduling and caching survey. GPU resource layout belongs to the GPU survey.

`PLAN.md` requirements served:

- Tiles, level of detail and streaming: quadtree pyramids, selection by SSE from each source's geometric error, parent fallback, pinned base, lazy refinement, no-data handling, motion-aware detail.
- Rendering and visual quality: no black areas, no popping (imagery cross-fades, terrain geomorphs), no seams or cracks, independent terrain and imagery levels, no gaps at the poles or the antimeridian, frustum and horizon culling.
- Performance and quality targets: zero black pixels after the base loads, no visible popping, 60 fps (p95 ≤ 16.7 ms) on the reference desktop.
- Features F080–F148 in `feature_list.json`, in particular F081–F085, F105, F106, F110, F111 (M3) and F126, F134, F137–F143 (M4).

## 2. Projects studied

All clones were shallow and sparse, read on 2026-10-20 and then deleted.

| Project               | Version, commit                    | License                                  | Files read                                                                                                                                                                                                                                                                                                                |
| --------------------- | ---------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CesiumJS              | 1.146.0 (engine 26.4.0), `621826d` | Apache-2.0                               | [QuadtreePrimitive.js][c-qp], [GlobeSurfaceTileProvider.js][c-gstp], [GlobeSurfaceTile.js][c-gst], [ImageryLayer.js][c-il], [TileImagery.js][c-ti], [TerrainFillMesh.js][c-fill], [TerrainProvider.js][c-tp], [CesiumTerrainProvider.js][c-ctp], [QuadtreePrimitiveSpec.js][c-spec], [TerrainFillMeshSpec.js][c-fillspec] |
| osgEarth (REX engine) | 3.8.1, `8652051`                   | MIT at this commit (older releases LGPL) | [SelectionInfo.cpp][o-sel], [TileNode.cpp][o-tile], [RexEngine.Morphing.glsl][o-morph], [RexEngine.ImageLayer.glsl][o-img], [TerrainOptions][o-opt], [TileMesher.cpp][o-mesh]                                                                                                                                             |
| iTowns                | 2.46.0, `6960a14`                  | CeCILL-B and MIT                         | [TiledGeometryLayer.js][i-tgl], [GlobeLayer.js][i-globe], [LayeredMaterialNodeProcessing.js][i-lmnp], [LayerUpdateStrategy.ts][i-strat], [computeBufferTileGeometry.ts][i-buf], [view_3d_map.js][i-func]                                                                                                                  |
| OpenGlobus            | 1.0.0-rc33, `d2bdd88`              | Apache-2.0                               | [Node.ts][g-node], [QuadTreeStrategy.ts][g-qts], [EarthQuadTreeStrategy.ts][g-earth], [Segment.ts][g-seg]                                                                                                                                                                                                                 |
| NASA WebWorldWind     | 0.11.0, `5ffe2df`                  | Apache-2.0                               | [Tessellator.js][w-tess], [TiledImageLayer.js][w-til], [Tile.js][w-tile]                                                                                                                                                                                                                                                  |
| NASA WorldWind Java   | 2.2.1, `2543c23`                   | Apache-2.0                               | [RectangularTessellator.java][j-tess], [TiledImageLayer.java][j-til]                                                                                                                                                                                                                                                      |
| 3DTilesRendererJS     | 0.5.3, `3febfcf`                   | Apache-2.0                               | [traverseFunctions.js][t-trav], [TilesRendererBase.js][t-base], [TilesFadePluginBase.js][t-fade], [wrapFadeMaterial.js][t-dither], [QuantizedMeshPlugin.js][t-qm], [ImageOverlayPlugin.js][t-overlay]                                                                                                                     |
| MapLibre GL JS        | 6.15.0, `95c7031`                  | BSD-3-Clause                             | [covering_tiles.ts][m-cover], [covering_tiles.bench.ts][m-bench], [tile_manager.ts][m-tm], [tile_manager_raster.ts][m-fade], [tile_manager_raster_dem.ts][m-dem], [terrain_tile_manager.ts][m-ttm], [terrain.ts][m-terrain], [draw_raster.ts][m-draw]                                                                     |
| Martini               | 0.2.0, `f9a7a96`                   | ISC                                      | [index.js][mt-index], `bench.js`, `test/test.js`                                                                                                                                                                                                                                                                          |
| Delatin               | 0.2.0, `9bb2f34`                   | ISC                                      | [index.js][dl-index], `bench.js`, `test/test.js`                                                                                                                                                                                                                                                                          |

## 3. How each project solves it

### 3.1 CesiumJS

- **One quadtree, driven by terrain.** [QuadtreePrimitive][c-qp] traverses the terrain provider's tiling scheme (geographic 2×1 for quantized-mesh) depth first, near to far. SSE is `levelMaxGeometricError · drawingBufferHeight / (distance · sseDenominator)`. A fog term is subtracted and the result divided by `pixelRatio`, so it is in CSS pixels. The default threshold is 2. For heightmaps the level-0 error is estimated as `R · 2π · 0.25 / (tileWidth · tilesAtLevel0)`, halved per level ([TerrainProvider.js][c-tp]).
- **Selection with memory of the last frame.** Every tile records RENDERED, REFINED, CULLED or KICKED. A tile that meets SSE is drawn only if it was drawn last frame, was culled, is fully loaded, or `canRenderWithoutLosingDetail` holds. Otherwise its descendants stay drawn, so zooming out never loses detail.
- **Kicking.** When refining, if some visible children are not renderable and none were drawn last frame, the children are kicked and the parent is drawn. If more than `loadingDescendantLimit` (20) descendants wait, only the parent is loaded. Three load queues exist (blockers, rendered, preloaded ancestors; `preloadAncestors = true`).
- **Refining past terrain data.** Beyond the terrain's available levels, children are upsampled from the parent in a worker. A tile whose four children are all upsampled-only is not refined, so terrain refines past its data only where imagery has more detail.
- **Imagery derived from terrain.** For each terrain tile, [ImageryLayer][c-il] computes the imagery level from the terrain tile's geometric error (`getLevelWithMaximumTexelSpacing`, `errorRatio = 1`, cos(latitude) factor for Mercator). It attaches every overlapping imagery tile with a texture rectangle. Mercator imagery on geographic tiles uses a per-vertex Mercator coordinate inside ±85.05°. While loading, or after a failure, [TileImagery][c-ti] uses the nearest ready ancestor with a texture translation and scale. Extra passes are added when imagery tiles exceed the texture units.
- **Holes.** [TerrainFillMesh][c-fill] builds placeholder meshes for drawn tiles whose terrain has not loaded, from the edge heights of loaded neighbors (wrap across the antimeridian is tested).
- **Cracks.** Every tile has skirts. For quantized-mesh the skirt height is 5 × the level's geometric error ([CesiumTerrainProvider.js][c-ctp]). Skirts are hidden when the camera is underground or the globe is translucent.
- **No transitions.** There is no geomorphing and no imagery cross-fade on the globe. The morphing item of the 2013 roadmap was closed as not planned in 2026 ([#526](https://github.com/CesiumGS/cesium/issues/526)).

### 3.2 osgEarth (REX)

- **Distance ranges, not SSE, by default.** [SelectionInfo][o-sel] gives each level a visibility range: tile bounding-circle radius × `minTileRangeFactor` (7) × 2/1.405. An optional SCREEN_SPACE mode subdivides when the tile's projected size exceeds `tilePixelSize` (256) plus an SSE margin ([TileNode][o-tile]).
- **Children exist immediately with inherited data.** When in range, children are created at once and inherit the parent's color, elevation and normal textures through quadrant scale-bias matrices. Each child then loads its own data. In `progressive` mode a child waits until its parent is up to date.
- **Shared grid with elevation from a texture.** The grid is 17 × 17 (`tileSize`), and the elevation texture is sampled in the vertex shader.
- **Distance-based geomorphing.** [RexEngine.Morphing.glsl][o-morph] morphs each vertex toward its parent-grid neighbor. The factor comes from the vertex's eye distance between per-level `morphStart` and `morphEnd`, and the morph region is the last 34 % of each range (`_morphStartRatio = 0.66`). [RexEngine.ImageLayer.glsl][o-img] blends each imagery texel with the parent texture by the same factor (`morphImagery`).
- **Morphing instead of skirts.** Skirts are off by default (`heightFieldSkirtRatio = 0`, [TerrainOptions][o-opt]). The engine relies on morphing and an optional `normalizeEdges` pass.
- **Poles.** `restrictPolarSubdivision` lowers the maximum level of geographic tiles whose aspect ratio falls below 0.1–0.4, which starts near 72°.

### 3.3 iTowns

- **One tile tree, texel-based criterion.** Geometry and imagery share one tree ([TiledGeometryLayer][i-tgl]; geographic EPSG:4326 for the globe). A node subdivides when the projected diameter of its bounding sphere, divided by twice the texture diagonal, exceeds `sseSubdivisionThreshold` (1.0). Culling is OBB frustum culling plus Cesium-style horizon culling ([GlobeLayer][i-globe]).
- **Subdivision waits for data.** Subdivision is blocked until the node has its color and elevation textures (`hasEnoughTexturesToSubdivide`). Children are built asynchronously, and the parent stays visible until all four exist.
- **Fallback.** Children start with their parent's textures (`initFromParent`, [LayeredMaterialNodeProcessing][i-lmnp]), then fetch per layer through a strategy ([LayerUpdateStrategy][i-strat]): MIN_NETWORK_TRAFFIC (default), GROUP, PROGRESSIVE or DICHOTOMY.
- **Geometry.** Built on the CPU per tile, with elevation added in the vertex shader. Skirt length is a fixed ratio of the segment length; the code comment admits it should depend on the height difference ([computeBufferTileGeometry][i-buf]).
- **Poles.** Polar rows stop subdividing at level 5. There is no geomorphing or fade.

### 3.4 OpenGlobus

- **Three root trees.** [EarthQuadTreeStrategy][g-earth] uses a Web Mercator tree for ±85.05° and two geographic polar-cap trees for 85.05°–90°.
- **Projected-size selection.** [Node.renderTree][g-node] refines while the projected size of the tile's bounding sphere exceeds `lodSize`. That is 256 px, interpolated toward 512 px as the camera tilts, so oblique views load fewer tiles ([QuadTreeStrategy][g-qts]). A tile refines only when its terrain is ready. A hard cap of 1,000 drawn nodes applies.
- **Fallback.** While terrain loads, a node copies the matching sub-grid of its nearest ancestor with terrain (`whileTerrainLoading`).
- **Fade by blending.** With transition opacity enabled, a node that appears fades in while its previously drawn parent or children fade out over `transitionTime`. Nodes are sorted by level so both levels are drawn and blended.
- **Cracks: stitching for color, skirts for depth.** Each side picks an index table from the neighbor's grid resolution (`sidesSizes`, recomputed per frame from drawn neighbors). 50 km skirts ([Segment.ts][g-seg]) are drawn only in depth passes.

### 3.5 NASA WorldWind (Web and Java)

- **WebWorldWind tessellator.** [Tessellator.js][w-tess] builds terrain tiles of 32 × 32 cells, independent of the elevation tiles, and samples heights from the best available elevations. A tile splits when its cell size exceeds `detailControl` (40) × the pixel size at its distance ([Tile.mustSubdivide][w-tile]). The factor is doubled above 75°, which lowers detail there.
- **WebWorldWind stitching.** `refineNeighbors` forces neighbors to be within one level (a restricted quadtree). Edges facing a coarser neighbor use "lores" index sets.
- **WebWorldWind imagery.** [TiledImageLayer.js][w-til] has its own quadtree (`detailControl` 1.75). A missing texture is replaced by a mapped ancestor (`fallbackTile`), outgoing tiles fade per frame, and every imagery tile is drawn over every terrain tile it touches.
- **WorldWind Java.** [RectangularTessellator][j-tess] splits when a cell exceeds 10^−(1.3+detailHint) of the eye distance, with detail halved above 75°. A comment rejects pixel-size criteria as window-size dependent. Skirts drop to the globe's minimum elevation.

### 3.6 3DTilesRendererJS

- **Generic 3D Tiles traversal.** [traverseFunctions.js][t-trav] uses geometric-error SSE with `errorTarget` 16 px and REPLACE refinement. With `loadAncestors` (default true) a parent is shown as a placeholder until its children load. When not all children are ready, the active children are kicked.
- **Terrain and imagery as synthesized tile sets.** [QuantizedMeshPlugin][t-qm] reads `layer.json` availability. Beyond it, children are clipped from the parent's mesh (`clipToQuadrant`), and the skirt length is the tile's geometric error. [ImageOverlayPlugin][t-overlay] drapes imagery on any tile set: it raises a tile's geometric error to its overlay texel size and splits the geometry by clipping. Imagery therefore drives geometry refinement, as in Cesium.
- **Dithered fade.** [TilesFadePlugin][t-fade] fades tiles in and out over 250 ms with a 4 × 4 Bayer-dither discard ([wrapFadeMaterial][t-dither]). Surfaces stay opaque and depth-correct. Beyond 50 simultaneous fade-outs, tiles pop.

### 3.7 MapLibre GL JS

- **Per-tile desired zoom.** [coveringTiles][m-cover] gives each tile a desired integer zoom from its distance and pitch, bounded by `maxZoomLevelsOnScreen` and `tileCountMaxMinRatio`. Separate detail providers handle Mercator and globe.
- **Retention.** [TileManager][m-tm] retains loaded children (up to 3 levels) and ancestors (up to 10 levels) to cover ideal tiles that have no data yet.
- **Raster cross-fade.** [tile_manager_raster.ts][m-fade] pairs each ideal tile with a loaded ancestor (fading out) or with descendants. The raster shader mixes two textures over `raster-fade-duration`. [draw_raster.ts][m-draw] turns the fade off when terrain is enabled.
- **Terrain.** Raster-DEM tiles load one zoom lower (`deltaZoom = 1`, [terrain_tile_manager][m-ttm]). Each tile is a fixed 128 × 128 grid whose height comes from the DEM texture in the vertex shader. All layers are first rendered into textures per terrain tile ([terrain.ts][m-terrain]).
- **Edges and poles.** DEM borders are backfilled from neighbors to remove tile seams ([tile_manager_raster_dem.ts][m-dem]). Skirts are "auto" (tile width / 5) or "none". On the globe, the top and bottom rows extend to the pole.

### 3.8 Martini and Delatin

**Martini** builds a right-triangulated irregular network (RTIN) on a (2^k+1)² grid. Its error map is computed bottom-up, and each split vertex stores the maximum error of its subtree, so the two triangles that share a hypotenuse split together. A mesh for any maximum error is then extracted in one traversal, crack-free inside the tile. Tile edges still differ between neighbors, so skirts are needed.

**Delatin** ports Garland and Heckbert's greedy insertion. It adds the worst point to a Delaunay triangulation until the maximum error falls below a threshold. It works on any grid size and gives fewer triangles, but runs far slower.

Measured here: Node 22 on a 2.8 GHz Xeon, the two Terrain-RGB fixtures shipped with the libraries, timing averaged over repeated runs, script kept outside the repository.

| Tile (257² grid)        | Max error | Full grid (v / t) | Martini (v / t, time)          | Delatin (v / t, time)    |
| ----------------------- | --------- | ----------------- | ------------------------------ | ------------------------ |
| Fuji, relief 17–3,751 m | 1 m       | 66,049 / 131,072  | 59,931 / 118,932, 3.8 + 8.7 ms | 56,606 / 112,342, 426 ms |
| Fuji                    | 5 m       | 66,049 / 131,072  | 39,516 / 78,306, 3.8 + 6.6 ms  | 29,760 / 58,957, 210 ms  |
| Fuji                    | 20 m      | 66,049 / 131,072  | 13,137 / 25,866, 3.8 + 2.4 ms  | 7,923 / 15,577, 57 ms    |
| Plains, relief 19–252 m | 1 m       | 66,049 / 131,072  | 4,134 / 8,062, 3.8 + 0.6 ms    | 2,521 / 4,905, 17 ms     |
| Plains                  | 5 m       | 66,049 / 131,072  | 650 / 1,221, 3.8 + 0.1 ms      | 411 / 775, 6 ms          |

v = vertices, t = triangles. Martini time is error map + mesh extraction. On a 513² grid, Fuji at 5 m takes 13 + 17 ms with Martini (188 k triangles) against 597 ms with Delatin (124 k triangles).

Conclusion: against a full grid, adaptive meshes save 1.1–5× in triangles on steep terrain and 16–107× on plains. Delatin gives 5–40 % fewer triangles than Martini but takes 2–34× longer per tile (error map included), which suits an offline pipeline, not runtime.

## 4. Known failure modes from issue trackers

| Kind            | Issue                                                                                                                                                   | Symptom                                                                           | Root cause                                                                | Lesson                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Popping         | [CesiumGS/cesium#526](https://github.com/CesiumGS/cesium/issues/526)                                                                                    | Terrain LOD pops; "minimize popping by morphing" never done                       | No geomorph in the design; roadmap closed as not planned (2026)           | Transitions must be designed in from the start, not added later                         |
| Popping         | [NASAWorldWind/WebWorldWind#824](https://github.com/NASAWorldWind/WebWorldWind/issues/824)                                                              | WMTS tiles flicker; a coarse tile replaces finer ones                             | Fallback choice changes frame to frame                                    | Never replace displayed detail with a coarser tile without a transition                 |
| Popping         | [NASAWorldWind/WebWorldWind#353](https://github.com/NASAWorldWind/WebWorldWind/issues/353)                                                              | Flicker and endless redraws where finer imagery is missing                        | Fallback tiles re-enter the per-frame fade every frame                    | Fallback is not a transition; transitions must end, so render-on-demand can idle        |
| Popping         | [iTowns/itowns#2442](https://github.com/iTowns/itowns/issues/2442)                                                                                      | Terrain jumps between levels far apart                                            | MIN_NETWORK_TRAFFIC loads only very coarse and very fine levels           | Load progressively; transitions must handle multi-level jumps                           |
| Popping, hole   | [NASA-AMMOS/3DTilesRendererJS#1236](https://github.com/NASA-AMMOS/3DTilesRendererJS/issues/1236)                                                        | Background shows through fading tiles                                             | Two separately drawn, dithered fades fall out of sync                     | Blend parent and child inside one draw, never as two overlapping draws                  |
| Popping         | [maplibre/maplibre-gl-js#1077](https://github.com/maplibre/maplibre-gl-js/issues/1077)                                                                  | Semi-transparent layers flicker while zooming with terrain                        | Parent and child both drawn (no stencil in terrain mode)                  | The drawn set must partition the surface                                                |
| Crack           | [maplibre/maplibre-gl-js#1602](https://github.com/maplibre/maplibre-gl-js/issues/1602)                                                                  | Gaps between terrain tiles of different zoom                                      | Edge heights differ across levels                                         | Level boundaries need skirts or stitching                                               |
| Crack           | [maplibre/maplibre-gl-js#4991](https://github.com/maplibre/maplibre-gl-js/issues/4991)                                                                  | Skirts show as "cliffs" under semi-transparent rasters                            | Fixed-length skirts drawn into translucent content                        | Size skirts to the possible gap; keep them out of translucent and overlay passes        |
| Crack           | [CesiumGS/cesium#11459](https://github.com/CesiumGS/cesium/issues/11459)                                                                                | Skirts cast shadow artifacts                                                      | Skirts drawn in the shadow pass                                           | Exclude skirts from shadow and depth-only passes                                        |
| Crack           | [CesiumGS/cesium#13573](https://github.com/CesiumGS/cesium/issues/13573)                                                                                | Skirts cannot be hidden for terrain-like 3D Tiles                                 | Skirt visibility handled only in the globe code                           | Skirt visibility must be one switch (underground, translucent, clipping)                |
| Crack           | [iTowns/itowns#387](https://github.com/iTowns/itowns/issues/387)                                                                                        | Holes where skirts were resized                                                   | Skirt size linear in level, not in meters                                 | Derive skirt length in meters from geometric error                                      |
| Crack           | [pelicanmapping/osgearth#1757](https://github.com/pelicanmapping/osgearth/issues/1757)                                                                  | Cracks with `morph_terrain=false`; 6,000 requests for one view                    | REX relies on morphing to close level edges                               | A transition used to close cracks must never be optional; cap requests per view         |
| Seam            | [CesiumGS/cesium#6190](https://github.com/CesiumGS/cesium/issues/6190)                                                                                  | Seams at imagery tile borders (open since 2018)                                   | Linear filtering at edges ignores neighbor texels                         | Test contrasting borders; plan neighbor-texel borders if clamp-to-edge is not enough    |
| Seam            | [CesiumGS/cesium#7125](https://github.com/CesiumGS/cesium/issues/7125)                                                                                  | Visible line between level 12 and 13 imagery                                      | Source styling differs per level; levels mix in one view                  | Level boundaries are visible; temporal fades do not hide spatial ones                   |
| Seam            | [NASAWorldWind/WebWorldWind#722](https://github.com/NASAWorldWind/WebWorldWind/issues/722)                                                              | Tiles do not fit at 0° and 180° at the top level                                  | Inexact edge computation at the root                                      | Compute shared edges identically on both sides; property-test the antimeridian          |
| Seam            | [NASAWorldWind/WebWorldWind#793](https://github.com/NASAWorldWind/WebWorldWind/issues/793)                                                              | Mercator WMTS misregistered on geographic imagery                                 | Earth radius 6.3781e6 instead of 6.378137e6                               | Use exact WGS84 constants; test cross-scheme registration to 1 px                       |
| Seam, hole      | [CesiumGS/cesium#12769](https://github.com/CesiumGS/cesium/issues/12769), [#2195](https://github.com/CesiumGS/cesium/issues/2195)                       | Distorted or missing imagery across 180°                                          | Rectangle code assumes west < east                                        | Every extent operation must be wrap-aware                                               |
| Hole            | [maplibre/maplibre-gl-js#8781](https://github.com/maplibre/maplibre-gl-js/issues/8781)                                                                  | White gaps during zoom-out although ancestors are cached                          | Fallback search ignores cached ancestors                                  | The fallback must find any resident ancestor                                            |
| Hole            | [NASA-AMMOS/3DTilesRendererJS#1517](https://github.com/NASA-AMMOS/3DTilesRendererJS/issues/1517)                                                        | Tiles disappear                                                                   | Traversal stops at empty tiles that meet the error target                 | A tile without content must not end refinement or fallback                              |
| Hole            | [maplibre/maplibre-gl-js#8043](https://github.com/maplibre/maplibre-gl-js/issues/8043), [#5379](https://github.com/maplibre/maplibre-gl-js/issues/5379) | Pole-centred globe views drop a hemisphere; a tile blinks near the pole           | Per-source culling and retention near poles (open)                        | Pole-centred scenarios are mandatory tests                                              |
| Hole            | [iTowns/itowns#2816](https://github.com/iTowns/itowns/issues/2816), [#2159](https://github.com/iTowns/itowns/issues/2159)                               | Globe stops refining when an elevation layer lacks data                           | Geometry subdivision waits for elevation textures                         | Never couple geometry refinement to data arrival                                        |
| Hole            | [NASAWorldWind/WebWorldWind#497](https://github.com/NASAWorldWind/WebWorldWind/issues/497)                                                              | Blank tiles after browsing a lot of imagery                                       | Cache churn without a guaranteed fallback                                 | Keep a pinned base and keep fallback data resident                                      |
| Pop, sink       | [CesiumGS/cesium#13065](https://github.com/CesiumGS/cesium/issues/13065)                                                                                | Heightmap terrain sinks with each upsampled level                                 | Interpolation in lon/lat versus ECEF triangles; re-quantization compounds | Upsampling must reproduce the parent's displayed surface exactly, without re-quantizing |
| Over-refinement | [CesiumGS/cesium#7042](https://github.com/CesiumGS/cesium/issues/7042)                                                                                  | Over 300 imagery tiles per area in 3D against 6 in 2D                             | Imagery tied to every terrain tile, no level skipping                     | Choose imagery by its own error; skip levels                                            |
| Over-refinement | [CesiumGS/cesium#6066](https://github.com/CesiumGS/cesium/issues/6066), [#11879](https://github.com/CesiumGS/cesium/issues/11879)                       | Endless requests at the poles, then out of memory                                 | Geographic tiles converge; thousands in view                              | Polar tiling must bound tile counts                                                     |
| Under/over      | [CesiumGS/cesium#9470](https://github.com/CesiumGS/cesium/issues/9470), [#8117](https://github.com/CesiumGS/cesium/issues/8117)                         | Imagery one level too coarse beyond 45.88°; sharp in one place, blurry in another | Imagery level derived from terrain geometric error and rounded            | Imagery SSE must be texel-based and independent of terrain                              |
| Over-refinement | [maplibre/maplibre-gl-js#5650](https://github.com/maplibre/maplibre-gl-js/issues/5650)                                                                  | Pitched views load too much near the horizon, too little in the middle            | Distance-only zoom choice                                                 | Tilted views need an explicit tile-count control                                        |
| Complexity      | [iTowns/itowns#2421](https://github.com/iTowns/itowns/issues/2421)                                                                                      | Subdivision and fetch logic called buggy and hard to follow                       | Logic spread over strategies and flags                                    | Keep selection one small, documented, unit-tested function                              |

## 5. How they test and benchmark tile selection

- **CesiumJS.** Jasmine specs drive [QuadtreePrimitive][c-spec] frame by frame with a fake frame state. A [MockTerrainProvider][c-mock] scripts per-tile success, failure, upsampling and availability. Tests assert the render list, the load queues and kicking: skipping levels when availability is known, `loadingDescendantLimit`, keeping descendants on zoom-out, fills. [TerrainFillMeshSpec][c-fillspec] checks fill heights across the antimeridian. Rendering specs run WebGL in a browser, and Playwright e2e covers Sandcastle. Debug counters (tiles visited, rendered, culled, waiting for children, maximum depth) and `suspendLodUpdate` are inspected manually. There is no tile-count or performance benchmark.
- **MapLibre GL JS.** Vitest unit tests compare `coveringTiles` against golden tile-ID lists for globe and Mercator: zoomed in and out, pitched, rotated, antimeridian, high latitude, elevated center. Tile-manager tests cover retention of parents and children and the fade logic under fake timers. About 1,700 render tests compare `expected.png` images, including terrain `skirts-auto`, `skirts-none` and `tile-stiching`. [covering_tiles.bench.ts][m-bench] times `coveringTiles` in Vitest bench mode (Mercator and globe, pitch 0 and 60, 4096² viewport). End-to-end benchmarks compare releases in headless Chrome.
- **3DTilesRendererJS.** Unit tests cover traversal order, queueing, the overlay error-raising rule and the fade-plugin lifecycle. There are no visual or performance tests of traversal.
- **iTowns.** Mocha unit tests check the subdivision screen size and that texture requests stay within the source zoom range. Puppeteer functional tests load examples and assert displayed tile counts per level ([view_3d_map.js][i-func] expects 20 level-2 tiles).
- **OpenGlobus, osgEarth, WorldWind.** Unit tests cover geometry utilities only (OpenGlobus `SegmentLonLat`, osgEarth Catch tests outside REX). Terrain selection is checked by hand with example scenes (`.earth` files, sandboxes). Martini and Delatin have one fixture test each and a `console.time` bench.

Takeaway: the best practice is a pure, frame-steppable selection function with scripted data readiness (Cesium), golden tile sets per camera (MapLibre, iTowns), and micro-benchmarks next to the code (MapLibre). No project detects popping, cracks or holes automatically over recorded frames; `docs/plan/quality.md` requires it.

## 6. Literature

- **Ulrich, Chunked LOD (2002).** Precomputed chunks in a quadtree, each with a maximum geometric error δ. A chunk is drawn when ρ = δ·K/D ≤ τ, with K = viewport width / (2 tan(fov/2)). Skirts hide cracks. Vertices morph from the parent shape to their own heights as ρ approaches the threshold, using a stored per-vertex delta. Chunks and textures stream asynchronously. This is the model Cesium (selection) and osgEarth (morphing) follow.
- **Losasso and Hoppe, Geometry Clipmaps (2004).** Nested regular grids centered on the viewer, updated toroidally. Transition bands blend geometry and texture with α from the grid distance; zero-area triangles hide T-junctions. Triangle count is constant and the GPU path simple, but the method is not adaptive to roughness. It needs one regular elevation pyramid around the viewer, which does not fit per-source tile streaming, coverage holes and no-data. It is planar: spheres and poles need extensions (spherical clipmaps), and oblique views waste rings behind the camera.
- **Agafonkin, MARTINI (2019),** after Evans, Kirkpatrick and Townsend's RTIN. Real-time error-bounded meshes from heightmaps (§3.8).
- **Garland and Heckbert (1995), via Delatin.** Greedy Delaunay insertion. Near-minimal triangle counts, but too slow for runtime (§3.8).
- **Cozzi and Ring (2011).** Covers chunked LOD, geometry clipmapping, skirts, horizon culling with an ellipsoid occluder, and SSE. It is the background of Cesium's design.
- **Strugar, CDLOD (2009),** not in `PLAN.md`. Odd grid vertices slide onto even ones, so a morphed child equals its parent's grid exactly. This exactness argument is reused in the ADR.

## 7. Comparison of approaches

| Concern                  | Options seen                                                                                                                                                                                                                            | Trade-offs and failure modes                                                                                                                                                                                                                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Selection metric         | Geometric-error SSE (Cesium, 3DTiles); projected tile size (OpenGlobus, iTowns, osgEarth SSE mode); distance ranges (osgEarth); fraction of eye distance (WorldWind); per-tile desired zoom (MapLibre)                                  | SSE from geometric error is the only one tied to measurable error. Projected size and ranges ignore roughness. Every metric over-refines near the horizon without a tilt or haze control (#5650; OpenGlobus lerps `lodSize`)                                                             |
| Terrain–imagery coupling | Imagery level derived from the terrain tile (Cesium); one tree for both (iTowns, osgEarth, OpenGlobus); separate quadtrees composited per terrain tile (WebWorldWind); render-to-texture (MapLibre); overlay-driven splitting (3DTiles) | Derived levels give inconsistent sharpness (#8117, #9470) and request blow-ups (#7042). Separate trees composited per tile cost passes. Render-to-texture costs memory and disables fades. Refining geometry for imagery while sampling ancestor terrain is common to all mature engines |
| Fallback                 | Kick to parent (Cesium, 3DTiles); children inherit parent data at once (osgEarth, iTowns, OpenGlobus); retain parents and children (MapLibre); ancestor texture (WorldWind)                                                             | Inheriting data makes every tile drawable at once, as long as refinement never waits on data (iTowns #2816). Kicking needs memory of the last frame to avoid flicker                                                                                                                     |
| Transitions              | None (Cesium, iTowns); distance-based morph of terrain and imagery (osgEarth); time-based fade by blending (OpenGlobus, MapLibre, WebWorldWind); dithered fade (3DTiles)                                                                | Distance-based morph jumps whenever the threshold changes (motion-aware detail, adaptive quality) and cannot cover data arrival. Fades that draw two levels show background or double opacity (#1236, #1077); a single-draw two-texture mix (MapLibre raster, osgEarth imagery) does not |
| Terrain geometry         | Per-tile meshes (Cesium, 3DTiles, WorldWind Java); shared grid with height texture (osgEarth, MapLibre); CPU-regenerated grids (WebWorldWind, OpenGlobus, iTowns)                                                                       | Height textures make upsampling and morphing free and identical on CPU and GPU. Per-tile TINs save triangles (§3.8) but need a worker round trip for every upsample, and their morph targets are exact only for nested meshes                                                            |
| Cracks                   | Skirts (Cesium, MapLibre, iTowns, 3DTiles, WorldWind Java); index stitching with a restricted quadtree (WebWorldWind, OpenGlobus); morph and edge normalization (osgEarth)                                                              | Skirts are robust to any data mismatch, but wrong lengths leave holes or cliffs (#387, #4991) and they leak into shadow and translucent passes (#11459). Stitching needs neighbor levels each frame and still cracks when pyramids average heights (osgEarth #1757)                      |
| Poles                    | Geographic tiles (Cesium, iTowns, osgEarth, WorldWind) with detail cuts; Mercator plus geographic caps (OpenGlobus); stretched edge rows (MapLibre globe)                                                                               | Geographic tiling converges at the poles (#6066, #11879). Caps confine the problem to 85.05°–90°, where coarser detail is acceptable                                                                                                                                                     |

On WebGPU and WebGL2: sampling heights in the vertex shader is core in both. WebGL2 guarantees 16 vertex texture units, and R32F can be read with `texelFetch`; WebGPU uses `textureLoad` on `r32float`. Texture arrays exist in both (at least 256 layers). Clamp-to-edge works per layer, so slices in an array do not bleed into each other. Mixing two textures in one fragment needs explicit gradients (`textureGrad` / `textureSampleGrad`) when the texture changes inside a triangle, or mip selection spikes into a seam. A dithered fade needs alpha-to-coverage under MSAA, while a mix inside one draw behaves identically on both backends.

## 8. Chosen approach for VibeGlobeEngine

Full decision and options: [ADR 0006](../adr/0006-level-of-detail.md).

**Selection.**

- One surface quadtree in Web Mercator (±85.0511°), plus two geographic polar-cap trees (85.0511°–90°), is the unit that is culled and drawn.
- A surface tile refines while any layer needs more detail than it can carry: terrain by SSE from geometric error, each imagery layer by its own projected texel size.
- The default thresholds are 2 px for terrain and 1.5 render-target px per texel for imagery, scaled by quality preset, motion and haze.
- Each layer picks its own level per surface tile, so imagery levels never depend on terrain levels.
- Frustum and horizon culling use bounding volumes that include the height range. A hard cap on drawn tiles relaxes the thresholds gracefully.
- Cap tiles stop splitting once they are less than half as wide as they are tall. This bounds tile counts at the poles, at the cost of coarse detail within about 70 km of each pole.

**Fallback.**

- Refinement never waits for data. A new surface tile draws the best resident ancestor of each layer at once, as a UV sub-rectangle; terrain is sampled from the ancestor's displayed surface.
- The pinned base guarantees such an ancestor exists, and a base color covers anything no layer covers.
- Ancestor data stays resident while any descendant uses it, and no-data is terminal.
- The "parent never discarded early" rule holds at the data level, so there is no kicking and no flicker.

**Transitions.**

- Whenever the data a surface tile shows changes, its shader mixes the old ("from") and new ("to") texture over a fixed time (about 250 ms; measured in M3). This covers child data arriving, upsampled data improving, and zoom-out to a parent.
- Terrain heights and every imagery layer use the same mechanism. This is a time-based geomorph, exact at its end by construction.
- One draw per tile means no double geometry, no blending order and no z-fighting.
- Children on their way out finish their transition before the parent replaces them.

**Terrain geometry and cracks.**

- Every terrain source becomes height grids in workers: heightmaps decoded, quantized-mesh rasterized.
- Surface tiles share grid vertex buffers per (level, row, size), with heights read in the vertex shader. Upsampling, morphing and CPU height queries all evaluate one function.
- Grid size per tile is the smallest whose measured error meets the level's bound.
- Skirts hide level cracks. Their length comes from the geometric errors of the two levels, and they are left out of shadow, translucent and underground rendering.

**What M3 and M4 must measure** (recorded in benchmarks and ADR updates):

- Tile counts, requests and bytes per canonical view (nadir, 45°, 75° tilt; DPR 1 and 2) against the imagery threshold, with a histogram of on-screen texel size.
- Traversal time per frame and zero allocations at 1,000 tiles.
- Transition duration: popping-detector results and the share of frames with an active transition during `zoom-orbit-to-street`.
- Cap feather width and tile counts in `pole-orbit`.
- Zero sentinel pixels in `antimeridian-pan`.
- Grid sizes (16, 32, 64 cells): triangles, GPU time on the reference devices, and the vertex budget against a Martini mesh at the same error.
- Skirt length factor: sentinel pixels and wall visibility in `terrain-crack-sweep`.
- Rasterization error of quantized-mesh fixtures.
- Registration error of cross-scheme imagery at 0°, 45° and 75° (F141).

## 9. Open questions

- Default terrain format from the M9 pipeline: a heightmap with shared edges fits this design best; quantized-mesh brings no runtime benefit here. To be decided in the sources and data-pipeline surveys.
- Whether clamp-to-edge alone passes the border test (F106) under magnification, or neighbor-texel borders are needed (Cesium #6190).
- How three.js TSL exposes texture arrays and `textureLoad` on both backends (GPU survey). Fallback: separate textures with at most 4 per layer per draw.
- Haze-based threshold relaxation needs the M11 atmosphere; M3 uses a distance-only placeholder.
- Whether vector tiles and 3D Tiles (M13) reuse the same from/to transitions, or need a dithered fade for meshes that are not height fields.

[c-qp]: https://github.com/CesiumGS/cesium/blob/621826db344eb7f1248f6bd50ed4770563127f12/packages/engine/Source/Scene/QuadtreePrimitive.js
[c-gstp]: https://github.com/CesiumGS/cesium/blob/621826db344eb7f1248f6bd50ed4770563127f12/packages/engine/Source/Scene/GlobeSurfaceTileProvider.js
[c-gst]: https://github.com/CesiumGS/cesium/blob/621826db344eb7f1248f6bd50ed4770563127f12/packages/engine/Source/Scene/GlobeSurfaceTile.js
[c-il]: https://github.com/CesiumGS/cesium/blob/621826db344eb7f1248f6bd50ed4770563127f12/packages/engine/Source/Scene/ImageryLayer.js
[c-ti]: https://github.com/CesiumGS/cesium/blob/621826db344eb7f1248f6bd50ed4770563127f12/packages/engine/Source/Scene/TileImagery.js
[c-fill]: https://github.com/CesiumGS/cesium/blob/621826db344eb7f1248f6bd50ed4770563127f12/packages/engine/Source/Scene/TerrainFillMesh.js
[c-tp]: https://github.com/CesiumGS/cesium/blob/621826db344eb7f1248f6bd50ed4770563127f12/packages/engine/Source/Core/TerrainProvider.js
[c-ctp]: https://github.com/CesiumGS/cesium/blob/621826db344eb7f1248f6bd50ed4770563127f12/packages/engine/Source/Core/CesiumTerrainProvider.js
[c-spec]: https://github.com/CesiumGS/cesium/blob/621826db344eb7f1248f6bd50ed4770563127f12/packages/engine/Specs/Scene/QuadtreePrimitiveSpec.js
[c-fillspec]: https://github.com/CesiumGS/cesium/blob/621826db344eb7f1248f6bd50ed4770563127f12/packages/engine/Specs/Scene/TerrainFillMeshSpec.js
[c-mock]: https://github.com/CesiumGS/cesium/blob/621826db344eb7f1248f6bd50ed4770563127f12/Specs/MockTerrainProvider.js
[o-sel]: https://github.com/pelicanmapping/osgearth/blob/865205168b43d2fbdc702e07dcce2413137bfb56/src/osgEarthDrivers/engine_rex/SelectionInfo.cpp
[o-tile]: https://github.com/pelicanmapping/osgearth/blob/865205168b43d2fbdc702e07dcce2413137bfb56/src/osgEarthDrivers/engine_rex/TileNode.cpp
[o-morph]: https://github.com/pelicanmapping/osgearth/blob/865205168b43d2fbdc702e07dcce2413137bfb56/src/osgEarthDrivers/engine_rex/RexEngine.Morphing.glsl
[o-img]: https://github.com/pelicanmapping/osgearth/blob/865205168b43d2fbdc702e07dcce2413137bfb56/src/osgEarthDrivers/engine_rex/RexEngine.ImageLayer.glsl
[o-opt]: https://github.com/pelicanmapping/osgearth/blob/865205168b43d2fbdc702e07dcce2413137bfb56/src/osgEarth/TerrainOptions
[o-mesh]: https://github.com/pelicanmapping/osgearth/blob/865205168b43d2fbdc702e07dcce2413137bfb56/src/osgEarth/TileMesher.cpp
[i-tgl]: https://github.com/iTowns/itowns/blob/6960a14719a333fca86425e4b7b689733429e8b7/packages/Main/src/Layer/TiledGeometryLayer.js
[i-globe]: https://github.com/iTowns/itowns/blob/6960a14719a333fca86425e4b7b689733429e8b7/packages/Main/src/Core/Prefab/Globe/GlobeLayer.js
[i-lmnp]: https://github.com/iTowns/itowns/blob/6960a14719a333fca86425e4b7b689733429e8b7/packages/Main/src/Process/LayeredMaterialNodeProcessing.js
[i-strat]: https://github.com/iTowns/itowns/blob/6960a14719a333fca86425e4b7b689733429e8b7/packages/Main/src/Layer/LayerUpdateStrategy.ts
[i-buf]: https://github.com/iTowns/itowns/blob/6960a14719a333fca86425e4b7b689733429e8b7/packages/Main/src/Core/Prefab/computeBufferTileGeometry.ts
[i-func]: https://github.com/iTowns/itowns/blob/6960a14719a333fca86425e4b7b689733429e8b7/test/functional/view_3d_map.js
[g-node]: https://github.com/openglobus/openglobus/blob/d2bdd88ccf826d1106d279d1393f8457061d4eb2/src/quadTree/Node.ts
[g-qts]: https://github.com/openglobus/openglobus/blob/d2bdd88ccf826d1106d279d1393f8457061d4eb2/src/quadTree/QuadTreeStrategy.ts
[g-earth]: https://github.com/openglobus/openglobus/blob/d2bdd88ccf826d1106d279d1393f8457061d4eb2/src/quadTree/earth/EarthQuadTreeStrategy.ts
[g-seg]: https://github.com/openglobus/openglobus/blob/d2bdd88ccf826d1106d279d1393f8457061d4eb2/src/segment/Segment.ts
[w-tess]: https://github.com/NASAWorldWind/WebWorldWind/blob/5ffe2dfc54ab4d744fc9e587af9639c9910db228/src/globe/Tessellator.js
[w-til]: https://github.com/NASAWorldWind/WebWorldWind/blob/5ffe2dfc54ab4d744fc9e587af9639c9910db228/src/layer/TiledImageLayer.js
[w-tile]: https://github.com/NASAWorldWind/WebWorldWind/blob/5ffe2dfc54ab4d744fc9e587af9639c9910db228/src/util/Tile.js
[j-tess]: https://github.com/NASAWorldWind/WorldWindJava/blob/2543c234349c76f4a290e318b49f071ac156d2a0/src/gov/nasa/worldwind/terrain/RectangularTessellator.java
[j-til]: https://github.com/NASAWorldWind/WorldWindJava/blob/2543c234349c76f4a290e318b49f071ac156d2a0/src/gov/nasa/worldwind/layers/TiledImageLayer.java
[t-trav]: https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/3febfcff2869771a9152084b80312ae5e244133e/src/core/renderer/tiles/traverseFunctions.js
[t-base]: https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/3febfcff2869771a9152084b80312ae5e244133e/src/core/renderer/tiles/TilesRendererBase.js
[t-fade]: https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/3febfcff2869771a9152084b80312ae5e244133e/src/core/plugins/fade/TilesFadePluginBase.js
[t-dither]: https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/3febfcff2869771a9152084b80312ae5e244133e/src/three/plugins/fade/wrapFadeMaterial.js
[t-qm]: https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/3febfcff2869771a9152084b80312ae5e244133e/src/three/plugins/QuantizedMeshPlugin.js
[t-overlay]: https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/3febfcff2869771a9152084b80312ae5e244133e/src/three/plugins/images/ImageOverlayPlugin.js
[m-cover]: https://github.com/maplibre/maplibre-gl-js/blob/95c703172ab9d745eb809672006f68775cef7400/src/geo/projection/covering_tiles.ts
[m-bench]: https://github.com/maplibre/maplibre-gl-js/blob/95c703172ab9d745eb809672006f68775cef7400/src/geo/projection/covering_tiles.bench.ts
[m-tm]: https://github.com/maplibre/maplibre-gl-js/blob/95c703172ab9d745eb809672006f68775cef7400/src/tile/tile_manager.ts
[m-fade]: https://github.com/maplibre/maplibre-gl-js/blob/95c703172ab9d745eb809672006f68775cef7400/src/tile/tile_manager_raster.ts
[m-dem]: https://github.com/maplibre/maplibre-gl-js/blob/95c703172ab9d745eb809672006f68775cef7400/src/tile/tile_manager_raster_dem.ts
[m-ttm]: https://github.com/maplibre/maplibre-gl-js/blob/95c703172ab9d745eb809672006f68775cef7400/src/tile/terrain_tile_manager.ts
[m-terrain]: https://github.com/maplibre/maplibre-gl-js/blob/95c703172ab9d745eb809672006f68775cef7400/src/render/terrain.ts
[m-draw]: https://github.com/maplibre/maplibre-gl-js/blob/95c703172ab9d745eb809672006f68775cef7400/src/webgl/draw/draw_raster.ts
[mt-index]: https://github.com/mapbox/martini/blob/f9a7a96b583affff6f9196b9f816a7ee980c5751/index.js
[dl-index]: https://github.com/mapbox/delatin/blob/9bb2f3455c0435bb66eafd9000a6f3161d8451a4/index.js
