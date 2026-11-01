# 0006. Terrain and imagery level of detail

- Status: Accepted (partly superseded by 0013)
- Date: 2026-10-20
- Milestone: M3 (selection, fallback, imagery transitions, poles and antimeridian), M4 (terrain geometry, geomorphing, skirts)

## Context

`PLAN.md` asks for quadtree pyramids selected by screen-space error (SSE) from each source's geometric error, and a parent that is never discarded before its replacing children are ready. Missing tiles show their best ancestor, upsampled. A pinned base keeps the picture complete, and detail refines progressively and adapts to motion. Terrain and imagery choose their levels independently. Imagery cross-fades, terrain geomorphs, and there are no cracks, seams, holes, or gaps at the poles or the antimeridian. Targets: zero black pixels after the base loads, no visible popping, 60 fps on the reference desktop. Features F080–F148 turn this into tests.

The survey [docs/internal/research/level-of-detail.md](../research/level-of-detail.md) studied CesiumJS, osgEarth, iTowns, OpenGlobus, NASA WorldWind, 3DTilesRendererJS, MapLibre GL JS, Martini and Delatin, plus their issue trackers. The recurring failures are:

- Imagery levels derived from terrain give inconsistent sharpness and too many requests (CesiumJS #8117, #9470, #7042).
- Geographic tiling explodes at the poles (CesiumJS #6066, #11879).
- No transitions at all (CesiumJS #526), or fades that draw parent and child as two overlapping draws and expose background or double opacity (3DTilesRendererJS #1236, MapLibre #1077).
- Geometry refinement blocked by missing data (iTowns #2816, #2159).
- Upsampling that does not reproduce the parent surface (CesiumJS #13065).
- Badly sized skirts (iTowns #387, MapLibre #4991), and skirts leaking into shadows (CesiumJS #11459).
- Extents that are not wrap-aware at 180° (CesiumJS #12769, #2195).

`docs/internal/plan/architecture.md` §6 marks skirts as Proposed, with stitching as the alternative if skirts fail under steep tilt. This ADR confirms skirts. It also changes three plan items (see Consequences).

## Options considered

1. **Terrain-driven quadtree with imagery derived from it (CesiumJS).**
   - How it works: one quadtree in the terrain's tiling scheme. Each terrain tile picks the imagery level matching its own geometric error. Children not ready are "kicked" in favor of the parent. Skirts, no transitions.
   - Pros: proven at scale and data-agnostic.
   - Cons: imagery sharpness and request counts follow terrain, not the imagery's own resolution (#8117, #9470, #7042). Geographic tiles converge at the poles (#6066). Kicking needs per-tile memory of the last frame. There is still no geomorph after 13 years (#526).
2. **One quadtree per layer, composited per terrain tile (WebWorldWind multi-pass, MapLibre render-to-texture).**
   - Pros: layers are fully independent.
   - Cons: a draw per terrain–imagery pair, or a texture pool per terrain tile. MapLibre disables raster fades when terrain is on (`draw_raster.ts`). Parent and child overlap during zoom (#1077).
3. **Geometry clipmaps (Losasso and Hoppe).**
   - Pros: constant triangle count, simple GPU path.
   - Cons: not adaptive to roughness. Needs one regular elevation pyramid around the viewer, which does not fit per-source tiled streaming, coverage holes or no-data. Planar, so the ellipsoid and the poles need extensions. Oblique views spend rings behind the camera.
4. **Per-tile adaptive meshes (Martini-style RTIN for heightmaps, quantized-mesh TINs), with morph targets computed in workers.**
   - Pros: at equal error, 1.1–5× fewer triangles than a full grid on steep terrain and 16–107× on plains. Martini: 4–13 ms per 257² tile; Delatin: 2–34× slower for 5–40 % fewer triangles (survey §3.8).
   - Cons: every upsampled tile and every transition needs a worker round trip. Morph targets are exact only for nested meshes, so not for arbitrary TINs. Two geometry paths. Meshes cannot share buffers.
5. **View-dependent geomorphing and imagery blending (Ulrich, osgEarth, CDLOD).**
   - Pros: continuous with camera motion, symmetric for refine and coarsen.
   - Cons: the morph factor depends on the SSE threshold, so motion-aware detail, adaptive quality, resolution scale or DPR changes would move geometry instantly. Data arriving late still needs a time-based blend. Static views stay partly blended. Cracks appear when morphing is off (osgEarth #1757).
6. **Fades that draw two levels (OpenGlobus blending, 3DTilesRendererJS dithering, MapLibre retained parents).**
   - Pros: work with any content.
   - Cons: background shows through or opacity doubles (#1236, #1077). Blending order and depth fights between levels. Fallback tiles that never stop fading prevent the render loop from idling (WebWorldWind #353).
7. **Stitching (WebWorldWind, OpenGlobus) instead of skirts.**
   - How it works: index variants per neighbor level on a restricted quadtree.
   - Cons: needs neighbor levels every frame. Still cracks when the data pyramid averages heights between levels. Cannot cover transient differences during transitions.
8. **Chosen:** one surface quadtree in Web Mercator plus polar caps. Each layer picks its own level by its own error. Data falls back to resident ancestors without waiting. Terrain heights and imagery both use time-based from/to transitions inside one draw. Terrain is rendered as height grids, and skirts hide cracks. Details below.

## Decision

Option 8. The pieces are deliberately few and uniform: one traversal, one fallback rule, one transition mechanism for every layer, and one terrain representation.

**1. Surface quadtree.** The unit that is culled and drawn is a surface tile from three roots:

- a Web Mercator root covering ±85.0511°;
- two geographic polar-cap roots covering 85.0511°–90° and −90°–−85.0511°, each spanning all longitudes.

Tile keys carry a root id beside the packed level/x/y index. Columns wrap modulo 2^level, and every extent operation is wrap-aware (half-open intervals; the 180° edge computed identically from both sides).

A cap tile splits only while its east–west ground width at its equatorward edge is at least half its north–south height. This bounds tile counts near the pole (the CesiumJS #6066 failure). The cost is that detail within about 70 km of each pole stays coarse; that is accepted.

Terrain and imagery sources keep their own tiling schemes (Web Mercator, geographic, custom). They are sampled per vertex through coordinates computed in float64 relative to the surface tile.

**2. Selection.** Each frame, traverse visible surface tiles near to far.

- Culling: frustum against a bounding volume built from the tile's extent and the displayed terrain's height range, widened by the ancestor's geometric error when the range is inherited. Horizon culling against the ellipsoid uses a horizon point built from the maximum height.
- Pixel size: `p = 2·d·tan(fovY/2) / H`, with `d` the float64 distance from the camera to the bounding volume and `H` the render-target height in pixels (CSS pixels × DPR × resolution scale, so tiles stay sharp at scale 1; F109).
- A tile refines while any layer needs more than the tile can carry:
  - Terrain, while `e / p > τ_terrain`, where `e` is the geometric error of the terrain the tile can show: the error of the data level matched to the tile's grid spacing, plus the measured grid decimation error and the ellipsoid sagitta. Terrain stops driving refinement once its finest level is reached.
  - Each imagery layer, while the ground size of a texel at the finest level the tile can carry, divided by `p`, exceeds `τ_imagery`. The finest level the tile can carry is the deepest level at which at most two source tiles cover it.
- Each leaf shows, per layer, the coarsest level at or below that one that meets the threshold. Imagery levels therefore never depend on terrain levels (F140).
- Thresholds start at `τ_terrain = 2` and `τ_imagery = 1.5` render-target pixels. They are multiplied by factors for motion, quality preset, distance haze (a placeholder until M11) and a drawn-tile cap (1,000), all of which only change smoothly. Tiles coarsen only below 0.8 × the threshold (hysteresis), so a tile at the boundary does not flip every frame.

**3. Fallback and loading.**

- Refinement never waits for data. A new surface tile draws, for every layer, the deepest resident ancestor-or-self of the level it wants, as a UV sub-rectangle. Terrain heights are sampled from the ancestor's displayed surface.
- The pinned base (levels set by the scheduling ADR) guarantees such an ancestor. Where no layer has coverage, a base color is drawn, never the clear color.
- The only time a parent stays drawn in place of its children is when the shared vertex buffer for a child's (root, level, row, grid size) is not built yet.
- Any data referenced by a drawn tile is pinned in memory, so the parent's data cannot be discarded before the children's own data has replaced it on screen.
- HTTP 404 and out-of-coverage are terminal no-data. Failures retry under the scheduler's policy while the ancestor stays shown.
- Requests go to the wanted level and to every second missing ancestor level between it and the shown level, coarse first. This gives progressive refinement (F085) at a few percent extra requests; priorities belong to the scheduling ADR.

**4. Transitions.** Every surface tile keeps, for terrain heights and for each imagery layer, a pair `from → to` (each a data-tile reference with a UV transform) and a progress `t`.

- `t` advances with elapsed time over a fixed duration T, initially 250 ms. The shader samples both and mixes them. At `t = 1`, `from := to`.
- A transition starts whenever the data a visible tile shows changes: its own data arrives, a better ancestor arrives, or it coarsens to its parent's data. Changes while a tile is culled apply instantly.
- Split: the four children inherit the parent's pairs and `t` with sub-rectangle UVs, so the image is identical.
- Merge: the children run transitions toward the parent's shown data (reversing a running transition whose `from` already equals it). When all four reach `t = 1`, the parent replaces them; the image is identical. If the parent's data is not resident, the children stay drawn and request it.
- Terrain height is `mix(H_from, H_to, t)`. Each `H` is the piecewise-linear surface of its data on grids that all use the same diagonal direction, so nested grids are exact. A transition therefore ends exactly on the target surface (F138), and a child sampling its parent's data reproduces the parent's surface (the CesiumJS #13065 lesson).
- Parent and child are never drawn at the same time, so there is no blending order, no z-fighting and no background showing through.
- A tile with a running transition keeps the render loop alive only until `t = 1`.
- Where the source texture changes inside a triangle, sampling uses explicit gradients so mip selection does not create seams.

**5. Terrain geometry.**

- Workers decode every terrain source into float32 height grids per data tile, with the minimum and maximum height and the decimation error for each grid size. Quantized-mesh is rasterized after decoding. Terrarium and Terrain-RGB are decoded and clamped within their own pixels, so no neighbor data is needed. Vertical datums are converted there.
- A surface tile is a regular grid of `g` cells per side, `g` ∈ {8, 16, 32, 64}: the smallest whose measured error meets the level's bound (F134).
- Vertex buffers are shared per (root, level, row, `g`). They hold tile-center-relative ellipsoid positions and normals, flat-map positions for M5, and per-vertex source coordinates. Each tile is placed by a float64 model-view (rotation about the polar axis plus translation) under the precision ADR.
- The vertex shader reads heights with `texelFetch` (WebGL2) or `textureLoad` (WebGPU) and displaces along the ellipsoid normal.
- CPU elevation queries and the shader evaluate the same interpolation function. A TypeScript reference implementation backs both the queries and the shader tests.

**6. Cracks.** Same-level neighbors share vertex positions and evaluate the same height function, so they cannot crack. Level boundaries and running transitions are covered by skirts, which confirms the Proposed item in `docs/internal/plan/architecture.md` §6:

- A skirt hangs below each edge along the ellipsoid normal.
- Its length is 2 × (the tile's geometric error + its parent's), and at least the edge's sagitta.
- It reuses the edge's texture coordinates.
- It is left out of shadow and depth-only passes, translucent-globe rendering and underground views.

Stitching is not used. If the crack sweep shows visible walls, snapping odd edge vertices to the coarser neighbor (CDLOD-style, no index variants) is the measured follow-up.

**7. Poles.**

- Mercator imagery fades to transparent over its last ~0.5° before 85.0511°, so the geographic base in the caps joins without a line (F110).
- Mercator-only terrain continues its 85.0511° heights into the caps.
- The flat map does not draw the caps.

## Consequences

**Easier:**

- One traversal produces the drawn set, the wanted tiles and the transitions. There is no kicking state, no overlap and no per-layer quadtree join.
- Independent levels and cross-scheme sources are handled by the same per-vertex sampling.
- Transitions are uniform and exact at their end.
- Selection, fallback and the height function are pure TypeScript functions that can be unit-tested and frame-stepped like Cesium's specs, with golden tile sets per camera like MapLibre's.

**Harder:**

- Shaders sample up to two textures per layer for the from/to pair (four where a tile straddles a non-aligned row of another scheme), which costs fragment work.
- Quantized-mesh loses its exact TIN vertices to rasterization; the error is measured and added to the geometric error.
- Regular grids use more triangles than RTIN on smooth terrain; the grid size per tile limits this, and Martini-style RTIN stays the measured fallback if M4 is vertex-bound.
- Detail within about 70 km of the poles stays coarse.
- Ancestors stay resident while used.
- Tile keys gain a root id.

**Plan updates needed in `docs/internal/plan/architecture.md`** (not edited here):

- §2 step 6: one surface traversal with per-layer levels, not one quadtree per layer.
- §6 Replacement and No popping: refinement does not wait for data; transitions mix inside one draw, with no ancestor drawn underneath; terrain geomorphing is time-based.
- §6 skirts: confirmed, no longer Proposed.
- §9: quantized-mesh is rasterized to height grids, not drawn as per-tile meshes.
- §6: tile keys include the root (Mercator, north cap, south cap).

**Verification.**

- Unit and property tests:
  - golden selected sets per camera with scripted data readiness and frame stepping;
  - children exactly cover parents, including caps and the antimeridian;
  - SSE monotonic with distance;
  - morph and upsample exactness, i.e. the end of a transition equals the target surface;
  - skirt lengths;
  - zero allocations in the traversal.
- Micro-benchmarks next to the traversal (Vitest bench): time per frame at 1,000 tiles.
- Scenario tests on WebGPU and forced WebGL2, with sentinel clear color and the temporal detectors: `zoom-orbit-to-street`, `pole-orbit`, `antimeridian-pan`, `independent-levels`, `terrain-crack-sweep`, `terrain-alps`, `terrain-horizon-peaks`.
- Values to measure and record in this ADR's follow-ups:
  - in M3: `τ_imagery`, T, the drawn-tile cap, the haze factor and the cap feather;
  - in M4: grid sizes, the skirt factor and rasterization error.
- Measurements are recorded per the survey §8 list: tile counts, requests and bytes per canonical view at DPR 1 and 2, texel-size histogram, triangles and GPU time per view, popping and black-pixel detector results.

## Update 2026-10-21 (polar refinement in M2)

M2's geographic surface quadtree had no polar rule, and zooming in at a pole selected every tile of the polar row (KB-043). §1's cap rule now applies to it ahead of the M3 caps: a tile splits into four only while its east–west width at its equatorward edge is at least half its north–south height, and otherwise only in latitude, into two children of twice the width. Tiles therefore stay square-ish above 60° latitude and become wedges at least about 29° wide at the poles; the selection's geometric error takes the larger of the meridian and parallel chord sags. M3's Mercator quadtree with caps keeps the rule.

## Update 2026-10-21: imagery cross-fades and skirts (M3, F105)

- **Cross-fade:** when a surface tile's imagery changes, its one draw mixes the old and the new texture for `GlobeOptions.imageryFadeMs` (250 ms of engine time by default; 0 switches at once). The state lives per surface tile key in typed arrays (`packages/core/src/imagery/fades.ts`); the texture faded from stays resident until the fade ends.
- **A fade under way finishes first:** imagery that arrives during a fade waits for it to end and then fades in, so what a tile shows never jumps (restarting a fade mid-way changed pixels by up to half the difference in one frame).
- **Perceptual mix:** the two samples are mixed in a gamma-2 space (square root, mix, square). Mixed in linear light, dark pixels changed several times faster than bright ones in sRGB, beyond the popping detector's 255/15 + 4 per frame.
- **Skirts slope outward** as far as they hang down (KB-069): vertical skirts only touched at the corners where tiles of different levels meet, and WebGPU left one sample there uncovered. At this slope a skirt stays inside the ellipsoid, so it never shows beyond the silhouette.

## Update 2026-10-25: edge stitching and polar cap heights (KB-178, KB-180)

- **Edges next to coarser terrain take its heights.** Skirts alone left walls of up to 240 m where a tile showing fine terrain met one showing a coarser level: the fine tile's edge followed its own grid, the coarse tile's edge its own. Every frame, a draw next to neighbors showing coarser terrain now binds a third height texture, the ancestor of its own terrain tile at the coarsest of those levels, and the vertices on the edges facing them sample it (`packages/core/src/terrain/terrain-stitch.hot.ts`, `TileDrawLayer.stitchEdges`). That ancestor is the neighbor's own terrain tile or the one beside it, so the edge matches the neighbor's exactly; measured edge by edge on the Mont Blanc scenario, the offsets went from 36–240 m to 0. An edge next to a neighbor of intermediate detail keeps its own heights, and skirts still cover what remains.
- **Same-level edges** differed where each heightmap tile extrapolated its outer half pixel (§5): up to 275 m at level 8 in the Alps. The pipeline now writes terrain tiles of 258 px, 256 of their own and a ring of the neighbors' pixels, and the decoder reads any heightmap of a power of two (16 or more) plus 2 pixels that way, interpolating its edges between its own and its neighbors' pixels, so neighbors give the shared edge the same heights. Other sources keep §5's extrapolation.
- **Skirts reach out four times the flat globe's skirt depth, not their own.** KB-069 made skirts reach out four times as far as they hang down; with terrain they hang down twice the terrain error, hundreds of meters, so they reached out up to a kilometer as nearly flat sheets above every slope that fell away from an edge more steeply than 14°. On the Alps those were the walls and sheets on screen. The reach now stays the flat globe's (four times the chord-sag depth, a few meters), which closes KB-069's corners as before, and the terrain only deepens the skirts. A quarter of the depth everywhere was tried first: it reopened KB-069's holes on the flat globe (F105, F110).
- **Polar caps fade Mercator terrain to the ellipsoid.** §7 continued the 85.0511° edge heights unchanged up to the pole, which raised the cap into blocks of the edge row's relief, with walls between cap tiles of different levels (KB-180). The caps now scale those heights linearly in latitude, from 1 at 85.0511° to 0 at the pole, in the shader and in the CPU height queries alike, so the join at 85.0511° stays without a step.

## Update 2026-10-31: skirts stay shallow with terrain, edges follow a coarser mesh (KB-302)

- **The terrain no longer deepens the meshes' skirts.** With 3D terrain, a vector base map (the Europe preset's Map)
  showed a line one pixel wide along tile edges: skirts twice the terrain error deep (hundreds of meters) won the depth
  test against the map draped over the surface on part of the MSAA samples, whatever the drape's pull toward the eye (up
  to 6% of the distance was tried), and without MSAA or without those skirts the line was gone. The skirts are now the
  flat globe's, a few meters deep, with or without terrain (`surface-cache.ts`): edges next to coarser terrain follow
  it (stitching, above), and the frame still deepens a draw's skirts, and its neighbors', while it shows terrain coarser
  than its level or morphs from it (`TileDrawLayer.skirtMeters`).
- **Edges next to a coarser mesh follow its segments.** Shallow skirts no longer hid the T-junctions between a tile and
  a neighbor one or more levels coarser showing the same terrain: the crack sweep found holes on WebGPU. `stitchEdges`
  now also holds, in its top three bits, how many levels coarser (up to four) the neighbor's mesh is, and the surface
  shader moves each vertex of that edge onto the straight segment between the vertices it shares with the neighbor, a
  vertex every 2^levels of its own. F137, F138 and F139 pass on both backends.
