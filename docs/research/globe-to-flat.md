# Globe-to-flat transitions

Survey for the globe-to-flat morph: projection morphing on the GPU, keeping the anchor point fixed, terrain height scaling on the flat plane, zoom-driven tilt and relief curves, and poles and the antimeridian during the morph. The decision is recorded in [ADR 0008](../adr/0008-globe-to-flat-morph.md). It is built in milestone M5.

## Scope and requirements served

`PLAN.md`, Map experience: globe, 2D and 3D:

- One continuous camera. The view is a globe at world and continent scale, flattens at country scale, is a flat Web Mercator map at region and city scale, and tilts to 45–60° at neighborhood and street scale. Nothing switches modes and nothing jumps.
- Every transition is a smooth function of zoom. Curves may overlap slightly.
- The morph interpolates positions between the ellipsoid and the plane on the GPU, "as MapLibre does".
- The geographic point under the cursor, or at the screen center, stays fixed during the morph.
- On the flat plane, terrain heights are scaled by the projection's scale factor. Measurements stay on the ellipsoid.
- The 2D-locked and manual-tilt modes keep the morph working.

Rendering and visual quality: the poles and the antimeridian show no gaps or seams, and the poles need caps beyond about ±85°. Feature list entries F143–F156 (M5) turn these into tests, and later entries (data layers, vector tiles, 3D Tiles, atmosphere) require the same continuity through the morph.

## Projects studied

| Project        | Version                                                                                                                            | License      | Files read                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MapLibre GL JS | [v6.15.0](https://github.com/maplibre/maplibre-gl-js/tree/v6.15.0) (`638b3f9`)                                                     | BSD-3-Clause | `src/geo/projection/{globe_projection,globe_transform,globe_utils,globe_camera_helper,vertical_perspective_transform,vertical_perspective_camera_helper,mercator_transform,projection_factory}.ts`, `src/shaders/glsl/_projection_globe.vertex.glsl`, `src/ui/map.ts` (`_render`), `developer-guides/globe.md`, `test/integration/render/tests/projection/globe/*`, `globe_transform.test.ts` |
| CesiumJS       | [1.146](https://github.com/CesiumGS/cesium/tree/1.146) (`b8d3a36`)                                                                 | Apache-2.0   | `packages/engine/Source/Scene/{SceneTransitioner,Scene,SceneTransforms,GlobeSurfaceTileProvider,BillboardCollection,Cesium3DTileset,ScreenSpaceCameraController}.js`, `Shaders/GlobeVS.glsl`, `Shaders/Builtin/Functions/columbusViewMorph.glsl`, `packages/core/Source/WebMercatorProjection.js`, specs `SceneSpec`, `CameraSpec`, `GeometryRenderingSpec`, `Cesium3DTilesetSpec`            |
| deck.gl        | [v9.4.0](https://github.com/visgl/deck.gl/tree/v9.4.0) (`5eded84`)                                                                 | MIT          | `modules/core/src/shaderlib/project/{project.glsl.ts,viewport-uniforms.ts}`, `modules/core/src/viewports/{globe-viewport,viewport}.ts`, `modules/core/src/views/globe-view.ts`, `modules/mapbox/src/deck-utils.ts`, `test/modules/core/shaderlib/project/project-glsl.spec.ts`, `test/modules/core/viewports/globe-viewport.spec.ts`, `test/render/test-cases/views.spec.ts`                  |
| OpenGlobus     | `main` at [`d2bdd88`](https://github.com/openglobus/openglobus/tree/d2bdd88ccf826d1106d279d1393f8457061d4eb2) (package 1.0.0-rc33) | Apache-2.0   | `src/quadTree/earth/EarthQuadTreeStrategy.ts`, `src/quadTree/{wgs84,equi,EPSG4326}/*`, `src/segment/{Segment,SegmentLonLat}.ts`, `src/layer/{XYZ,WMS}.ts`, `tests/SegmentLonLat.test.js`                                                                                                                                                                                                      |

Mapbox GL JS v2 and later is excluded by license and was not consulted.

## How each project solves it

### MapLibre GL JS: a center-anchored blend between globe and Mercator

- **Zoom-driven factor.** The `globe` projection is a style expression that interpolates linearly from `vertical-perspective` at zoom 11 to `mercator` at zoom 12 ([projection_factory.ts](https://github.com/maplibre/maplibre-gl-js/blob/v6.15.0/src/geo/projection/projection_factory.ts#L57)). `GlobeProjection.transitionState` turns that expression into a "globeness" value between 0 and 1. `Map._render` pushes globeness into the transform every frame.
- **Two child transforms, one camera.** `GlobeTransform` owns a Mercator transform and a vertical-perspective transform that share one `TransformHelper` (center, zoom, bearing, pitch). The globe matrix applies perspective, pulls back by the camera-to-center distance, applies pitch and bearing, translates by the globe radius and rotates by the center's latitude and longitude. Both matrices therefore place the map center at the same pixel with the same tangent frame ([vertical_perspective_transform.ts](https://github.com/maplibre/maplibre-gl-js/blob/v6.15.0/src/geo/projection/vertical_perspective_transform.ts#L497)).
- **Matched scale.** The globe radius in pixels is the world size divided by 2π cos(center latitude) ([`getGlobeRadiusPixels`](https://github.com/maplibre/maplibre-gl-js/blob/v6.15.0/src/geo/projection/globe_utils.ts#L84)), so at the center one zoom level means the same pixel scale on the sphere and on the Mercator plane. To stop the planet from growing as the user pans toward a pole, globe controls add `getZoomAdjustment` = log2(cos φnew / cos φold) to the zoom ([globe_utils.ts](https://github.com/maplibre/maplibre-gl-js/blob/v6.15.0/src/geo/projection/globe_utils.ts#L374)).
- **GPU blend.** `interpolateProjection` in [_projection_globe.vertex.glsl](https://github.com/maplibre/maplibre-gl-js/blob/v6.15.0/src/shaders/glsl/_projection_globe.vertex.glsl#L106) does three things:
  - It projects each vertex twice: once on the unit sphere, raised by `elevation / GLOBE_RADIUS`, through the globe matrix, and once through the per-tile Mercator "fallback" matrix.
  - It mixes clip-space x, y and w by globeness.
  - It replaces z with a custom value from a plane that clips the far side of the planet, fades that z in only after globeness 0.2, and hides the pole-fan vertices except in the last 2% of the transition.

  The Mercator matrix equals the globe's view matrix times a y-flip. So, by our derivation, the clip-space blend is algebraically a world-space linear interpolation, in the map center's tangent frame, between the sphere and a Mercator plane scaled to match it at the center. This is the morph `PLAN.md` refers to.

- **Why the transition sits at zoom 11–12.** It exists to escape float32 precision on the unit sphere ([developer-guides/globe.md](https://github.com/maplibre/maplibre-gl-js/blob/v6.15.0/developer-guides/globe.md#floating-point-precision--transitioning-to-mercator)). At zoom 11.5 the two surfaces differ by about 0.6 px of sagitta, and by 1–2 px of Mercator scale change at 45–60° latitude, at the edge of a 1080-px view. That is why the transition is "only noticed if you look very closely".
- **CPU paths do not blend.** In [globe_transform.ts](https://github.com/maplibre/maplibre-gl-js/blob/v6.15.0/src/geo/projection/globe_transform.ts#L247), picking, `locationToScreenPoint`, `setLocationAtPoint`, culling and the camera helpers all use the pure globe whenever globeness > 0. Only the shader and a few lerped corrections (pixel scale, pitched-text correction) see the blend. Zoom-around-cursor solves `setLocationAtPoint` on the globe, blending toward a heuristic far from the center and near the horizon ([vertical_perspective_camera_helper.ts](https://github.com/maplibre/maplibre-gl-js/blob/v6.15.0/src/geo/projection/vertical_perspective_camera_helper.ts#L85)).
- **Terrain scaling.** In Mercator, elevation is multiplied by the pixels-per-meter at the center latitude, one value for the whole view ([mercator_transform.ts](https://github.com/maplibre/maplibre-gl-js/blob/v6.15.0/src/geo/projection/mercator_transform.ts#L940)). On the globe, elevation lifts the vertex radially by true meters. Because the radius is scaled by 1/cos(center latitude), the two agree at the center only.
- **Poles and antimeridian.**
  - Tiles in the first and last Mercator rows get a fan of triangles to the pole, which stretches the edge row of data ([globe.md, "Data near the poles"](https://github.com/maplibre/maplibre-gl-js/blob/v6.15.0/developer-guides/globe.md#data-near-the-poles)).
  - Raster tiles are drawn twice with stencil to avoid seams.
  - A fragment-shader clip handles the antimeridian on the zoom-0 tile.

### CesiumJS: time-based morphing between scene modes

- **Explicit, time-driven modes.** `Scene.morphTo2D`, `morphToColumbusView` and `morphTo3D` (default duration 2 s) run tweens in [SceneTransitioner.js](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Scene/SceneTransitioner.js). The morph is not driven by zoom.
  - First the camera position, direction and up are lerped toward a target camera with `QUARTIC_OUT` easing.
  - Then `scene.morphTime` is tweened between 1 (3D) and 0 (2D/CV).
  - Going to 2D adds a perspective-to-orthographic frustum tween.
  - Animated 3D→2D and 2D→3D send the camera to a fixed overview, either (0, 0, 5·maxRadius) in projected space or above 0°N 0°E ([`morphFrom3DTo2D`](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Scene/SceneTransitioner.js#L732)). Only a zero-duration morph keeps the location.
  - Any mouse-down or wheel input completes the morph at once (`completeMorphOnUserInput`, [Scene.js](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Scene/Scene.js#L275)).
- **World-space vertex morph.** [`getPositionMorphingMode`](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Shaders/GlobeVS.glsl#L103) works as follows:
  - It rebuilds the absolute 3D position by adding the tile center back, which disables relative-to-center rendering. The source comment admits "potential for jitter".
  - It computes the 2D position in the shader from the tile rectangle uniform and a Web Mercator y fraction per vertex (`webMercatorT`), with height as the first axis of Cesium's permuted 2D frame.
  - It mixes the two with `czm_columbusViewMorph`. That function writes the mix out by hand because `mix` on some NVIDIA and Intel Arc GPUs is not exact at 0 and 1 ([columbusViewMorph.glsl](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Shaders/Builtin/Functions/columbusViewMorph.glsl)).
- **Heights.** Columbus view keeps raw meters (`WebMercatorProjection.project` sets z = height, [WebMercatorProjection.js](https://github.com/CesiumGS/cesium/blob/1.146/packages/core/Source/WebMercatorProjection.js#L87)). Relief is therefore not scaled by the projection's scale factor: at 60° it looks half as tall relative to the stretched ground. 2D drops height entirely.
- **Everything else during the morph.**
  - Tile bounding spheres are the union of the 3D and 2D spheres ([GlobeSurfaceTileProvider.js](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Scene/GlobeSurfaceTileProvider.js#L820)).
  - Billboards recompute their positions every frame.
  - `SceneTransforms` lerps projected and 3D positions for picking.
  - 3D Tiles are not drawn at all while morphing ([Cesium3DTileset.js](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Scene/Cesium3DTileset.js#L3499)).
  - Terrain-height camera adjustment is skipped.
- **Antimeridian in 2D.** Infinite-scroll 2D splits the viewport at the antimeridian's screen column and renders the scene twice with the camera shifted by one world width ([`execute2DViewportCommands`](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Scene/Scene.js#L3469)).

### deck.gl: projection modes in one shader module, switched by zoom

- **One function, a mode switch.** `project_position` branches on `projectionMode` ([project.glsl.ts](https://github.com/visgl/deck.gl/blob/v9.4.0/modules/core/src/shaderlib/project/project.glsl.ts#L188)):
  - `WEB_MERCATOR` computes absolute Mercator in common space.
  - `WEB_MERCATOR_AUTO_OFFSET` uses offsets from the viewport center, with a first-order latitude correction (`commonUnitsPerWorldUnit2`).
  - `GLOBE` uses a 256-unit sphere computed with GPU sin and cos (`project_globe_`).
  - `IDENTITY` handles non-geographic views.
- **Hard switches at zoom 12, no morph.**
  - A geospatial viewport selects absolute Mercator below zoom 12 and auto-offset above it, for precision ([viewport.ts](https://github.com/visgl/deck.gl/blob/v9.4.0/modules/core/src/viewports/viewport.ts#L205)).
  - `GlobeView` returns a `GlobeViewport` up to zoom 12 and a `WebMercatorViewport` above it ([globe-view.ts](https://github.com/visgl/deck.gl/blob/v9.4.0/modules/core/src/views/globe-view.ts#L57)).
  - The globe is scaled by latitude like MapLibre's (`zoomAdjust`, [globe-viewport.ts](https://github.com/visgl/deck.gl/blob/v9.4.0/modules/core/src/viewports/globe-viewport.ts#L123)), so the two converge at the switch.
- **Following MapLibre.** The MapLibre integration picks `GlobeView` whenever the map's projection type is `globe`, whatever MapLibre's current globeness ([deck-utils.ts](https://github.com/visgl/deck.gl/blob/v9.4.0/modules/mapbox/src/deck-utils.ts#L176)).
- **Terrain and size scaling.** In `WEB_MERCATOR` mode each vertex's elevation and meter-based size is multiplied by 1/cos(latitude) of that vertex (`project_size_at_latitude`, [project.glsl.ts](https://github.com/visgl/deck.gl/blob/v9.4.0/modules/core/src/shaderlib/project/project.glsl.ts#L61)). A Taylor series in Mercator y stands in when only common-space positions are known. This is per-vertex Mercator scaling of heights, the behavior F151 asks for.

### OpenGlobus: several projections on one globe, no flat map

- **Mixed quadtrees.** `EarthQuadTreeStrategy.init` builds three quadtree roots ([EarthQuadTreeStrategy.ts](https://github.com/openglobus/openglobus/blob/d2bdd88ccf826d1106d279d1393f8457061d4eb2/src/quadTree/earth/EarthQuadTreeStrategy.ts#L65)): a Web Mercator root (`Segment`, EPSG:3857) between ±85.05°, and two `SegmentLonLat` roots (EPSG:4326) for the polar caps. Visible nodes are collected per group, and tile indices are computed per group.
- **Per-segment projection.** Every segment carries its projection. XYZ (Mercator) imagery is applied only to segments whose projection matches the strategy's ([XYZ.ts `_checkSegment`](https://github.com/openglobus/openglobus/blob/d2bdd88ccf826d1106d279d1393f8457061d4eb2/src/layer/XYZ.ts#L156)). WMS layers request each segment's bounding box in that segment's own CRS ([WMS.ts](https://github.com/openglobus/openglobus/blob/d2bdd88ccf826d1106d279d1393f8457061d4eb2/src/layer/WMS.ts)). Polar caps therefore show 4326 imagery or a default texture.
- **Other planets.** `wgs84`, `equi` and `EPSG4326` strategies serve fully geographic or equirectangular planets.
- **No flat mode.** There is no 2D or flat mode and no morph. OpenGlobus is studied here for its pole caps and per-region projections.

## Known failure modes from issue trackers

| Issue                                                                                                                          | Symptom                                                                                                                    | Root cause                                                                                                           | Lesson                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [maplibre-gl-js#8714](https://github.com/maplibre/maplibre-gl-js/issues/8714)                                                  | Map-aligned circles swell by up to 25% at 60°N halfway through the zoom 11–12 transition                                   | The radius correction was blended on the CPU and again in the shader ("blend applied twice"); fixed in #8717         | Apply the morph exactly once, in one shared function                             |
| [maplibre-gl-js#6542](https://github.com/maplibre/maplibre-gl-js/issues/6542)                                                  | Collision boxes and `queryRenderedFeatures` drift from labels during an interpolated projection                            | Collision "either assumes full globe projection or full mercator, no inbetween"                                      | Placement, collision and picking must use the same morph as the GPU              |
| [maplibre-gl-js#7660](https://github.com/maplibre/maplibre-gl-js/issues/7660)                                                  | Markers and 3D models float above terrain at zoom 11–12                                                                    | The Mercator camera is lifted by the center elevation and the globe camera is not                                    | Use one camera, and include the anchor's elevation identically in both endpoints |
| [maplibre-gl-js#5622](https://github.com/maplibre/maplibre-gl-js/issues/5622)                                                  | A three.js model distorts and clips around the switch to Mercator                                                          | Mercator and globe compute different near/far planes                                                                 | Fit one depth range to the morphed geometry                                      |
| [maplibre-gl-js#7419](https://github.com/maplibre/maplibre-gl-js/issues/7419)                                                  | Latitudes overlap at zoom 11 on Mali-G610/G710; positions are off by 200–300 m                                             | GPU sin and cos error, amplified to Earth radius; fixed with exp-only algebra (#7916)                                | No GPU trigonometry for positions; precompute in float64                         |
| [maplibre-gl-js#5296](https://github.com/maplibre/maplibre-gl-js/issues/5296)                                                  | Globe drag inverts near the poles                                                                                          | Bearing-preserving `setLocationAtPoint` "will often have no solution near the poles"; fixed with versor drag (#8154) | Anchor solves need a well-conditioned fallback near the poles and the limb       |
| [maplibre-gl-js#5009](https://github.com/maplibre/maplibre-gl-js/issues/5009)                                                  | With terrain, the antimeridian becomes unreachable once the globe switches to Mercator                                     | Not diagnosed; appeared only on the Mercator side of the switch                                                      | Use one wrap rule in every phase                                                 |
| [maplibre-gl-js#4929](https://github.com/maplibre/maplibre-gl-js/issues/4929)                                                  | Line-label spacing breaks near the poles on the globe                                                                      | Line labels are laid out on a flat "label plane"                                                                     | Lay labels out in the space that is actually drawn                               |
| [cesium#2065](https://github.com/CesiumGS/cesium/issues/2065)                                                                  | After an animated morph to 3D the camera "jumps back" to the US (open, priority high)                                      | The animated morph does not keep the camera; only duration 0 does                                                    | The anchor must be preserved by construction, not by a final snap                |
| [cesium#5144](https://github.com/CesiumGS/cesium/issues/5144)                                                                  | Labels jump at the end of a morph (open since 2017)                                                                        | Not diagnosed; the morph ends in a discrete mode change that re-places labels                                        | Data layers must follow the same continuous function                             |
| [cesium#5041](https://github.com/CesiumGS/cesium/issues/5041)                                                                  | Ground-clamped billboards sit in the wrong place during a morph (fixed 2026, #13639)                                       | Not diagnosed; clamping did not follow the morphed surface                                                           | Clamp against the morphed surface                                                |
| [cesium#9538](https://github.com/CesiumGS/cesium/issues/9538)                                                                  | After 2D→3D, orbit paths draw in front of the globe                                                                        | Not diagnosed; mode-dependent state after the switch                                                                 | No mode-specific render state                                                    |
| [cesium#10484](https://github.com/CesiumGS/cesium/issues/10484), [cesium#8768](https://github.com/CesiumGS/cesium/issues/8768) | In 2D infinite scroll, primitives west of the date line are culled and `globe.pick` fails when the antimeridian is visible | Not diagnosed; 2D renders the world twice with a shifted camera, which culling and picking must mirror               | Avoid duplicated-world rendering; wrap relative to the view                      |
| [deck.gl#9466](https://github.com/visgl/deck.gl/issues/9466)                                                                   | Layers are misprojected after MapLibre switches between globe and Mercator                                                 | Layers "do not react to projection change"                                                                           | A transition must not require rebuilding layer data                              |
| [deck.gl#10870](https://github.com/visgl/deck.gl/issues/10870)                                                                 | MVT tiles cached on one side of zoom 12 draw in the wrong frame on the other                                               | `GlobeViewport` parses tiles to lng/lat and `WebMercatorViewport` to tile coordinates, with the same cache           | Tile data must be projection-independent, carrying both endpoints                |
| [deck.gl#10804](https://github.com/visgl/deck.gl/issues/10804)                                                                 | GlobeView positions are up to 981 m off under SwiftShader, and the view jumps 43 px at the zoom 12 switch                  | Software-renderer sin and cos error (about 1e-4) times Earth radius                                                  | CI on SwiftShader must not see GPU trigonometry in positions                     |
| [deck.gl#10206](https://github.com/visgl/deck.gl/issues/10206)                                                                 | Z-fighting flicker and flat, untessellated discs on the MapLibre globe                                                     | No tessellation in globe mode, and depth that does not match the basemap                                             | Tessellate long primitives; share one depth convention                           |
| [openglobus#534](https://github.com/openglobus/openglobus/issues/534)                                                          | The pole area stretches when no imagery is available                                                                       | Polar `SegmentLonLat` tiles have no source data, so neighbors are stretched                                          | Caps need a guaranteed source (the pinned global fallback)                       |

## How they test transitions

- **MapLibre.**
  - Render tests are a `style.json` plus an expected PNG, compared pixel by pixel. The projection/globe suite has 51 cases.
  - [`zoom-transition`](https://github.com/maplibre/maplibre-gl-js/tree/v6.15.0/test/integration/render/tests/projection/globe/zoom-transition) checks that Mercator is in effect at zoom 16. `pole-cap`, `antimeridian-lod` and `fill-planet-pole` cover the poles and the antimeridian.
  - Only one mid-transition frame is tested: `circle-pitch-alignment/zoom-transition` at zoom 11.5, added with the #8714 fix.
  - Unit tests in `globe_transform.test.ts` cover project/unproject round trips, `setLocationAtPoint`, clipping-plane half-spaces and "unproject behind the pole". Benchmarks (`transform_hot_paths.bench.ts`) time the transforms.
  - The precision fix #7419 was validated by render fixtures only; on-device Mali results were still pending.
- **CesiumJS.**
  - Jasmine specs render with WebGL and assert `toRender` / `notToRender`. Morphs are tested either instantly (`morphTo2D(0)`) or by setting `scene.morphTime`.
  - Behavior specs include "flyTo camera after morph", "does not render during morph" (3D Tiles), "pick map in morph" and picking of ground polylines in the morph.
  - No test records an animated morph frame by frame, which is how jump-at-the-end bugs (#2065, #5144) stay open.
- **deck.gl.**
  - Vitest viewport tests include anchor-stability tests for globe panning.
  - GPU-versus-CPU projection tests run the shader on known inputs and compare it with the JavaScript projection at a tolerance of 1e-4 ([project-glsl.spec.ts](https://github.com/visgl/deck.gl/blob/v9.4.0/test/modules/core/shaderlib/project/project-glsl.spec.ts#L26)).
  - Golden-image tests (`globe-mvt`) run on SwiftShader in CI, which #10804 shows is unrepresentative for GPU trigonometry.
- **OpenGlobus.** Vitest unit tests use a mocked WebGL context (for example `SegmentLonLat.test.js`). There are no rendering tests; users found the pole defects.

What the field lacks, and what VibeGlobeEngine must add:

- frame-sequence tests through the whole transition
- per-frame anchor-drift checks
- CPU/GPU parity tests of the morph on every backend, including SwiftShader
- sentinel-color gap tests at the poles and the antimeridian during the sweep

## Literature

- **Cozzi and Ring (2011).** Relative-to-center and relative-to-eye vertex precision. The morph must keep relative-to-center rendering, unlike Cesium's morph path. Also geodetic surface normals and horizon culling.
- **van Wijk and Nuij (2003).** Flights move in (position, view width) space. If the curves are functions of ground scale, the morph, tilt and relief follow a flight continuously, with no special case.
- **Karney (2013).** Geodesics on the ellipsoid. Measurements use picked geographic coordinates in every phase, never plane coordinates.
- **Outside the `PLAN.md` list.**
  - Snyder, _Map Projections: A Working Manual_ (USGS PP 1395, 1987): the Mercator scale factor sec φ, and the identity sec φ = cosh(y/R) used below.
  - IOGP Guidance Note 7-2: EPSG:3857 applies the spherical formulas to WGS84 latitude, so it is not conformal on the ellipsoid. Its east–west scale is sec φ·√(1−e² sin² φ), and its north–south scale differs by at most 0.67%.
  - Jenny, "Adaptive Composite Map Projections" (IEEE TVCG 18(12), 2012): zoom-dependent projection blending for web maps.

## Comparison of approaches

| Approach                                                     | Anchor                                                      | CPU/GPU consistency                                    | Precision                                          | Poles / antimeridian                                       | Fit for a country-scale morph                                                                            |
| ------------------------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Clip-space blend of two synchronized cameras (MapLibre)      | Center exact; cursor approximate (solved on the globe only) | Broken: CPU paths use one endpoint                     | GPU sphere from Mercator y; needs the exp trick    | Pole fans hidden during the blend; stretched edge rows     | Works only where the endpoints differ by ≤2 px (zoom 11–12); at country scale they differ by about 50 px |
| Time-based mode morph (Cesium)                               | Lost when animated (camera flies to an overview)            | Partial: billboards and picking lerp; 3D Tiles hidden  | Relative-to-center disabled while morphing         | 2D renders the world twice; culling and picking bugs       | Not zoom-driven; user input snaps the morph                                                              |
| Discrete switch (deck.gl GlobeView at zoom 12)               | Jumps (43 px under SwiftShader)                             | N/A                                                    | Globe from GPU sin and cos                         | N/A                                                        | Violates "no jump"                                                                                       |
| Mixed projections, globe only (OpenGlobus)                   | N/A                                                         | N/A                                                    | CPU-built segments                                 | Geographic polar caps with their own quadtrees             | No flat map, but the cap idea carries over                                                               |
| **Anchor-frame world-space morph on the ellipsoid (chosen)** | Center exact by construction; cursor exact by Newton solve  | One shared function on CPU (float64) and GPU (float32) | Relative-to-center throughout; no GPU trigonometry | Capped-Mercator caps; per-tile wrap relative to the anchor | Designed for it                                                                                          |

**WebGPU and WebGL2.** The chosen morph is plain vertex-shader arithmetic (two multiply-adds per component, plus one `exp` pair when relief is nonzero). It compiles from one TSL source to WGSL and GLSL, and uses real depth on both backends (reversed-Z or logarithmic). MapLibre's custom clip-space z is not needed because geometry is never blended after projection. Avoiding `mix` and trigonometry removes the vendor variance seen in Cesium's `mix` note, MapLibre#7419 and deck.gl#10804. Per-tile offsets travel as uniforms on WebGL2 and as dynamic-offset uniforms or storage buffers on WebGPU, as for relative-to-center rendering.

## Chosen approach for VibeGlobeEngine

Full rationale and alternatives: [ADR 0008](../adr/0008-globe-to-flat-morph.md).

1. **Morph space is the anchor's frame.** The anchor _a_ is the camera target, the point at screen center including its relief-scaled terrain height. Everything is expressed in the east-north-up frame _A_ of _a_.
   - Globe endpoint: G(v) = R_A·(E(φ,λ,r·h) − E(a)), where E is WGS84 geodetic to ECEF.
   - Plane endpoint: P(v) = σ·(wrap(x − x_a), y* − y*_a, r·(h·k(φ) − h_a·k(φ_a))).
     - x and y* are EPSG:3857 meters, with y* the capped Mercator y defined in step 7.
     - k(φ) = sec φ·√(1 − e² sin² φ) is the Mercator east–west scale on WGS84, clamped at ±85.0511°.
     - σ = 1/k(φ_a), so the plane's scale at the anchor equals the ground's.
     - r is the relief factor.
   - Morphed position: M(v) = (1 − m)·G(v) + m·P(v), written out explicitly, never `mix`, so both ends are exact.
   - Normals: normalize((1 − m)·n_G + m·n_P).
   - This is MapLibre's center-anchored blend, carried out in world space and on the ellipsoid.
2. **One camera whose pose does not depend on m.** The camera is placed in frame _A_ by distance, heading and tilt. The screen-center anchor therefore stays fixed by construction: no re-solve, no final snap.
3. **Cursor anchor.** At gesture start the geographic point under the cursor, p_c, is picked from the morphed surface. Each frame after the zoom step (which changes distance, ground zoom and m), a 2-D Newton solve of the target's (φ, λ) brings p_c back under the cursor:
   - float64, finite-difference Jacobian, at most 3 iterations, no allocation;
   - damped toward the center anchor near the limb or off the surface, as MapLibre and deck.gl do on the globe.
4. **Curves are functions of ground zoom.** Ground zoom z_g = zoom + log2 k(φ_target) measures ground scale at the target. It is independent of latitude, so the phase depends only on how much ground is in view. The curves:
   - use smootherstep (C², no velocity jumps);
   - are validated: ranges ordered, morph flat before tilt exceeds ε unless a configured overlap allows otherwise.

   Defaults below use the MapLibre zoom convention (512-px world at zoom 0), which the style expressions also use. They are starting values to tune in M5.

   | Curve     | Ground zoom         | Value     | Phase                                                                                                 |
   | --------- | ------------------- | --------- | ----------------------------------------------------------------------------------------------------- |
   | Morph m   | 4.0 → 6.5           | 0 → 1     | Flattening (country); at zoom 4 the globe is about 2,600 px across, so its limb has left a 1080p view |
   | Relief r  | ≤ 6.5 → 10.0 → 15.0 | 0 → 0 → 1 | Flat globe and flattening; subtle at city scale; full at street scale                                 |
   | Auto tilt | 14.0 → 16.5         | 0° → 50°  | 3D view (neighborhood, street)                                                                        |

   The default tilt of 50° is the configurable value F144 requires within 45–60°.

5. **Relief on the plane.** Each vertex's height is scaled by its own k(φ), normalized by σ, so it matches the ground at the anchor. This is deck.gl's per-vertex rule, made exact at the anchor, and it satisfies F151 (h maps to h·k(φ) plane units). In the shader, k = cosh(Y/a)·√(1 − e²·tanh²(Y/a)) uses only `exp`.
6. **Precision and memory.**
   - Workers precompute each vertex's globe offset (3×f32, relative to the tile's globe center) and plane offset (2×f32, relative to the tile's plane center) in float64, plus its height.
   - The CPU passes per-tile float32 offsets of both tile centers from the eye, so relative-to-center precision holds at every m.
   - The cost is +8 bytes per vertex over a globe-only mesh and no GPU trigonometry.
7. **Poles.**
   - Caps beyond ±85.0511° are geographic-scheme tiles with a full vertex row at ±90°: a point on the globe, a line on the plane.
   - Their plane position uses capped Mercator: y continued linearly, C¹ at the limit, which adds 0.32 of the Mercator half-height.
   - Imagery comes from the pinned global fallback, so a cap is never empty, stretched or hidden during the morph.
8. **Antimeridian.**
   - Each tile is placed at the wrap copy nearest the anchor; the wrap is per tile, never per vertex, so tiles are never torn.
   - The only cut is the meridian opposite the anchor. It is at least 1,746 km away at 85° latitude and 20,000 km at the equator.
   - The far plane is capped at the ellipsoid horizon distance for the camera altitude, with haze covering the cap, so the cut never enters the view. No world copies are needed and panning across 180° has no special case.
9. **Culling and depth.**
   - Morphed tile sphere: center (1 − m)·c_G + m·c_P, radius (1 − m)·r_G + m·r_P. It provably contains the tile and is tighter than Cesium's union.
   - Horizon culling uses the ellipsoid occluder at m = 0. For 0 < m < ½ it uses a conservative angular cut around the anchor at the morphed silhouette, cos θ_s = −m/(1 − m), widened by tilt. Above ½ there is no horizon cut.
   - Near and far planes are fitted to the morphed spheres.
10. **One morph function everywhere.** A TypeScript float64 implementation and a TSL implementation serve:
    - terrain and imagery, data layers (points, labels, and lines and polygons tessellated as in MapLibre's subdivision), picking, label placement and collision, bounding volumes and terrain clamping;
    - 3D Tiles and glTF, through a per-tile affine approximation (the morph's Jacobian at the tile center): exact at m = 0; for a 500 m tile at m = 1 the second-order error is millimetres at mid-latitudes and about 4 cm at 70°; never hidden.

    Measurements use picked geographic coordinates on the ellipsoid.

**Why.**

- It is the only studied approach that satisfies the zero-jump and anchor requirements across a country-scale band, where globe and plane differ by tens of pixels: about 47 px of sagitta at zoom 5.25.
- It avoids every failure class in the issue table by construction: one camera, one function, one depth range, no GPU trigonometry, no mode switch, no duplicated world.

### What must be measured in M5

| Measurement            | How                                                                                                                                                     | Pass                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Anchor drift           | `?scenario=morph-anchor`: wheel and pinch through the band at center, corners, near the limb and with heading; pick the cursor's coordinate every frame | ≤ 1 px every frame (F149); center ≤ 1 px (F150); Newton converges in ≤ 3 iterations     |
| CPU/GPU parity         | Readback test (as in deck.gl) of the TSL morph against the TypeScript one at m ∈ {0, 0.25, 0.5, 0.75, 1}, on WebGPU, WebGL2 hardware and SwiftShader    | ≤ 0.1 px screen difference                                                              |
| Continuity             | `?scenario=morph-sweep` 0 → 1 → 0, frame differencing                                                                                                   | No jump above threshold; no geometry re-upload (F146)                                   |
| GPU cost               | Frame time of the sweep against a static globe on the reference desktop and tablet                                                                      | Added vertex cost ≤ 0.3 ms per frame; otherwise add shader variants for m = 0 and m = 1 |
| Culling correctness    | Render the sweep with horizon and frustum culling on and off, including max manual tilt and 85° latitude                                                | Pixel-identical images                                                                  |
| Relief                 | Cone fixture at 0°, 45° and 70° (F151)                                                                                                                  | Height-to-base ratio equal within tolerance                                             |
| Poles and antimeridian | Sentinel clear color at 80°N and 80°S while sweeping morph and tilt (F154); drag-pan across 180° in 2D (F153)                                           | Zero sentinel pixels, no seam                                                           |
| Curves                 | Fine zoom sampling: continuity, monotonicity, bounded derivative (F143)                                                                                 | Phase ranges match the `PLAN.md` table                                                  |

## Open questions

1. **Pan scale in the 2D phase.** Because curves follow ground zoom, the camera-control ADR should keep ground scale constant while panning, as MapLibre does on its globe, so a pan never changes morph, tilt or relief. In the 2D phase, Mercator zoom then drifts by about 0.023 per 100 km of north–south pan at 45°, unlike Google Maps. The owner should confirm. The alternative (constant Mercator zoom when m = 1) is a local change to the pan handler, at the cost of pans nudging the curves near band edges.
2. **Tilt overlap.** `PLAN.md` says "tilt starts as the map finishes flattening", but its phase table puts a tilt-0 2D band (region, city) between flattening and 3D. The defaults follow the table; the overlap rule is enforced only when a configuration makes the bands adjacent.
3. **Shared terrain grid.** `docs/plan/architecture.md` §9 proposes a shared grid with height textures. The morph needs per-vertex globe offsets computed without GPU trigonometry, so the GPU and level-of-detail ADRs must either keep per-tile buffers or show a shared-grid variant (for example a second-order expansion around the tile center) with sub-millimeter error.
4. **Cut visibility.** Can the far-plane cap hide the cut under extreme manual tilt near the poles without visibly shortening the view? Measure in M5 at 85° latitude.
5. **3D Tiles and glTF.** Is the per-tile affine morph visually exact enough for large tiles during the sweep? Measure in M13.
