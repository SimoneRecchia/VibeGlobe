# Labels

- Status: Complete (survey for M10)
- Date: 2026-10-22
- Decision: [ADR 0029](../adr/0029-data-layers.md)

## 1. Scope and requirements

This survey covers text labels: glyph generation with signed distance fields (SDF), glyph atlases, collision indices, placement (priority, viewport, horizon) and fading. Shaping of complex scripts and line-following labels are mentioned only where they cause failures that placement must survive.

PLAN.md requirements it serves:

- **Glitch-free rendering:** no flicker, no single-frame pops, no labels lagging the map during motion.
- **Data layers (M10):** labels attached to points and features, with priorities and decluttering on the globe and the flat map.
- **Fixed constraints:** no servers (glyph ranges, if used, are hosted by the consumer, ADR 0015), offline mode, permissive third-party licenses only.
- **Engineering standards:** decoding and generation off the main thread, frame budget, deterministic results, visual behavior proved by browser tests.
- **Feature list:** F349 (this survey) and the M10 label entries that follow it.

## 2. Projects studied

| Project                      | Version / commit                              | License      | Files read                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | --------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MapLibre GL JS               | 6.15.0, `main` [`49f780a`][ml]                | BSD-3-Clause | `src/symbol/{placement,collision_index,grid_index,cross_tile_symbol_index,opacity_state}.ts`, `src/style/{pauseable_placement,style}.ts` (`_updatePlacement`), `src/render/{glyph_manager,glyph_atlas}.ts`, `src/shaders/glsl/symbol_sdf.fragment.glsl`, `src/source/worker_tile.ts`, `src/symbol/{placement,collision_index,symbol_layout,cross_tile_symbol_index}.bench.ts`, `test/integration/render/tests/symbol-cross-fade/`, `CHANGELOG.md` |
| MapLibre Native              | core 5.4.0 (Android 13.7.1), [`d2efacc`][mn]  | BSD-2-Clause | `src/mln/text/{placement,collision_index,cross_tile_symbol_index,glyph_manager}.cpp`, `src/mln/text/local_glyph_rasterizer.hpp`, `platform/darwin/core/local_glyph_rasterizer.mm`, `src/mln/gfx/{dynamic_texture,dynamic_texture_atlas}.cpp`, `test/text/`, `CHANGELOG.md`, `platform/{ios,android}/CHANGELOG.md`                                                                                                                                 |
| Tangram                      | 0.22.0, [`f24f47c`][tg] (last commit 2024-12) | MIT          | `src/labels/{collision,collision_grid,main_pass,repeat_group}.js`, `src/tile/tile_manager.js` (`updateLabels`), `src/styles/text/text_canvas.js`, `src/styles/points/points.js` (fade-in), `git log` (no changelog)                                                                                                                                                                                                                               |
| CesiumJS                     | 1.146.0, [`0c09769`][ce]                      | Apache-2.0   | `packages/engine/Source/Scene/{LabelCollection,Label,Billboard,SDFSettings}.js`, `Source/Renderer/TextureAtlas.js`, `Source/DataSources/EntityCluster.js`, `Source/Core/RectangleCollisionChecker.js`, `Specs/Scene/LabelCollectionSpec.js`, `Specs/Renderer/TextureAtlasSpec.js`, `CHANGES.md`                                                                                                                                                   |
| OpenLayers                   | 10.11.1-dev, [`73c527c`][ol]                  | BSD-2-Clause | `src/ol/renderer/Composite.js` (`declutter`), `src/ol/render/canvas/{Executor,ExecutorGroup,TextBuilder}.js`, `src/ol/render/canvas.js` (font checks), `test/rendering/cases/*declutter*` (16 cases), `changelog/*.md`                                                                                                                                                                                                                            |
| deck.gl                      | 9.4.0-beta.4, [`ce528a4`][dg]                 | MIT          | `modules/layers/src/text-layer/{text-layer,font-atlas-manager}.ts`, `modules/extensions/src/collision-filter/{collision-filter-extension,collision-filter-effect,shader-module}.ts`, `test/render/test-cases/{text-layer,collision-filter-extension}.spec.ts`, `test/bench/text-auto-wrapping.bench.js`, `CHANGELOG.md`                                                                                                                           |
| TinySDF (`@mapbox/tiny-sdf`) | 2.3.0, [`81da9d8`][ts]                        | BSD-2-Clause | `index.js`, `README.md`                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Green (2007)                 | SIGGRAPH 2007 course notes, [paper][green]    | n/a          | whole paper                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Supporting libraries checked on npm (2026-10-22): `rbush` 4.0.1 (MIT), `potpack` 2.1.0 (ISC), `@mapbox/shelf-pack` 3.2.0 (ISC). Browser support from `@mdn/browser-compat-data` 8.1.7.

## 3. How each project solves it

**Green (2007).** A low-resolution texture stores the distance to the nearest edge, mapped so 0.5 is the outline. Bilinear filtering of distances, then a threshold (alpha test or a `smoothstep` around 0.5 whose width follows the screen-space derivative), gives sharp edges far above the stored resolution; a 64×64 field replaces a 4096×4096 source. Outlines, glows and drop shadows are extra thresholds or offset samples of the same texture. Limit: sharp corners round off when magnified strongly (multi-channel SDF, e.g. msdfgen, MIT, fixes this at higher generation cost; no studied map engine uses it).

**MapLibre GL JS.**

- **Glyphs:** fonts come as prebuilt PBF ranges of 256 code points (SDF at 24 px, 3 px border) from the style's `glyphs` URL. CJK and other ideographs default to local rendering with TinySDF (`localIdeographFontFamily`); local glyphs are drawn at 48 px since [#3006][ml3006] ("double resolution (48px), greatly improving sharpness of CJK text"). `font-faces` files can now replace ranges entirely. The `GlyphManager` lives on the main thread: workers request glyphs over the actor and TinySDF draws with a canvas there.
- **Atlas:** each worker tile packs only the glyphs it uses into its own `GlyphAtlas` with `potpack` (1 px padding), uploaded with the tile. Batch packing fits because a tile's glyph set is known once and never grows; the cost is the same glyph duplicated across tiles.
- **Collision index:** a uniform `GridIndex` of 25 px cells over the viewport plus 100 px padding on every side (`viewportPadding`, commented as a stability-versus-cost trade-off). Boxes and circles (line labels) are queried, then inserted. A tolerance of 1e-6 in the AABB test fixed flicker ([#7360][ml7360]).
- **Placement:** a new `Placement` is built at most once per `fadeDuration` (300 ms default; shortened while zooming out by `zoomAdjustment`). `PauseablePlacement` time-slices it: each frame continues placement for at most 2 ms, then commits. Order: layer order, then `symbol-sort-key`, then tile order. The `CrossTileSymbolIndex` assigns one `crossTileID` to the same label in parent, child and neighbor tiles so opacity carries over when tiles swap ("Always hide duplicate labels" [mapbox #6166][mb6166]). Variable-anchor labels prefer the anchor they had last placement (`prevAnchor`); there is no other advantage for already-visible labels. Labels behind the globe are hidden even with overlap `always` ([#4802][ml4802]). Placement is skipped when its inputs are unchanged ([#8208][ml8208]).
- **Fading:** per-label `OpacityState` steps toward 0 or 1 by `(now − commitTime) / fadeDuration` at commit; the vertex buffer holds packed opacity and target, and the shader interpolates with a fade-change uniform, so fading costs one uniform per frame. Labels just inside the padded margin skip the fade (`skipFade`). Fading is forced to 0 until the first idle ([#2447][ml2447]).
- **Anchors:** projected every frame (CPU for line labels, shader for points), so labels never lag the map; only visibility waits for the next placement.
- **Sharpness:** the fragment shader uses `EDGE_GAMMA = 0.105 / devicePixelRatio`, scaled by font size and pitch.

**MapLibre Native.** Same algorithms in C++ (placement, `CrossTileSymbolIndex`, 300 ms minimum update period in `Placement::getUpdatePeriod`). Local glyphs come from platform rasterizers (Core Text, Android) and then TinySDF's C++ port; local CJK at 2x since [#4304][mn4304]. Unlike GL JS it has a shared dynamic glyph atlas ([#3198][mn3198]): a shelf packer (`shelf-pack-cpp`) with reference-counted bins; when full, a new texture of twice the size is added, and existing glyphs never move. Tile mode (static rendering) has its own placement with "Labels priority fixes" ([mapbox-gl-native #16432][mbn16432]) and "Stable position of labels at tile borders" ([#16040][mbn16040]).

**Tangram.** Text is rasterized as whole-label bitmaps with Canvas 2D (no SDF), supersampled for angled labels ([#467][tg467]) and aligned to the pixel grid ([#454][tg454]). Collision runs first per tile in workers, then a main-thread pass (`mainThreadLabelCollisionPass`) over all visible tiles, by priority (lower number first), with repeat groups and an adaptive grid (cell size from label density, commit `0a37f38`). The pass reruns only when the tile set or zoom rounded to `zoom_steps` changes. Labels fade in over 150 ms in the shader; there is no fade-out. Labels that breach tile edges are hidden while tiles load unless they were visible before (commits `8109082`, `08802cd`). Tiles are evaluated in build order to keep visible labels stable, which the commit (`b02b7a4`) notes "does cause label layout on initial page load to be nondeterministic".

**CesiumJS.** `LabelCollection` renders each glyph as a billboard. Glyphs are drawn with Canvas 2D at 48 px (`SDFSettings`: padding 10, radius 8, cutoff 0.25) and converted with `bitmap-sdf` since [#7730][ce7730] ("signed distance fields (SDF) for crisper text"). All billboards share one `TextureAtlas`; on overflow it is recreated larger and every image is repacked, so texture coordinates change ("Texture coordinates are subject to change if the texture atlas resizes"); the 2025 refactor made it resize "more conservatively" ([#172][ce172]) and reuse coordinates for existing subregions ([#2094][ce2094]). There is no label collision: labels overlap unless `EntityCluster` merges nearby points into clusters (`kdbush`, 80 px `pixelRange`). Occlusion by terrain and the globe uses the depth test, with `disableDepthTestDistance` to avoid clipping.

**OpenLayers.** Labels are drawn with Canvas 2D `fillText` (cached per style, with font-availability checks). Decluttering (`layer.declutter`) collects image and text boxes from every layer top-down into an `rbush` tree and rejects any box that `collides`, rebuilt from scratch on every rendered frame ("New decluttering implementation" [#11592][ol11592]; "Declutter in correct order and for all layers" [#9466][ol9466]). There is no fade: a label that loses a collision disappears in the next frame. Priority comes from layer order and `zIndex`.

**deck.gl.** `TextLayer` builds a font atlas with Canvas 2D at 64 px, optionally SDF via TinySDF (`sdf: false` by default; radius 12, cutoff 0.25). The atlas is 1024 px wide; new characters (with `characterSet: 'auto'`) are appended and the canvas grows in height, copying old pixels, so existing glyphs keep their positions; atlases are cached in an LRU per font setting ([#7337][dg7337]). `CollisionFilterExtension` ([#8255][dg8255]) renders every collidable object into an offscreen framebuffer at half resolution, ordered by `getCollisionPriority` (−1000 to 1000), with picking colors; each vertex shader then samples a 5×5 neighborhood to decide visibility, which gives a soft fade "to reduce the flicker". It is GPU-only and per frame, with no hysteresis and no CPU query of what is shown.

## 4. Trade-offs

| Choice              | Options seen                                                                                                             | Trade-off                                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Glyph source        | Prebuilt PBF SDF (MapLibre), local Canvas 2D + SDF (MapLibre CJK, Cesium, deck.gl), bitmaps (Tangram, OpenLayers)        | PBF: identical everywhere, needs hosted ranges. Local: no server, any script, but platform fonts differ and canvas readback can be noised by anti-fingerprinting. Bitmaps: sharp only at one scale. |
| SDF resolution      | 24 px (PBF), 48 px (MapLibre local, Cesium), 64 px (deck.gl)                                                             | Higher keeps CJK strokes and large text sharp; costs 4–7x atlas area.                                                                                                                               |
| Atlas               | Per-tile batch pack (MapLibre), shared shelf with new pages (Native), append rows (deck.gl), repack all (Cesium)         | Batch pack is optimal but static; repacking moves coordinates (Cesium's long-standing problems); shelves grow without moving glyphs.                                                                |
| Collision structure | Uniform grid (MapLibre, Native, Tangram), R-tree (OpenLayers), GPU framebuffer (deck.gl)                                 | Grid is fastest for similar-sized boxes; R-tree handles mixed sizes and arbitrary queries; GPU scales but gives no CPU result and blurs edges.                                                      |
| Placement frequency | Every frame (OpenLayers, deck.gl), throttled to 300 ms and time-sliced (MapLibre), on tile or zoom-step change (Tangram) | Per frame reacts instantly but pops; throttling plus fades is the only studied scheme without pops, at the cost of brief overlaps during fast zoom-out.                                             |
| Fade                | Fade in and out 300 ms (MapLibre), fade in only 150 ms (Tangram), none (OpenLayers, Cesium), spatial soft edge (deck.gl) | Symmetric fades hide every change; no fade-out means visible pops when labels lose collisions.                                                                                                      |

## 5. Known failure modes

- **Blurry text:** CJK too soft at 24 px, fixed by 48 px local glyphs ([#2990][ml2990], [#3006][ml3006]; Native [#4304][mn4304]); blurry iPad landscape from a varying scale factor ([Native #4373][mn4373]); vertically misaligned small glyphs ([Cesium #8474][ce8474]) and wrong label sizes for some fonts ([Cesium #9767][ce9767]). Tangram notes that snapping text to the pixel grid "provides crisper sprites, but adds wobbliness when panning" (commit `0fa39b3`).
- **Flicker during motion:** "Fixed symbol collision flickering by adding tolerance to GridIndex AABB comparison" ([#7360][ml7360]); Native "Fix the symbol blink issue" ([#3534][mn3534]) was reverted for regressions ([#3610][mn3610]); hover flicker from tile-based querying ([mapbox #6497][mb6497]); Cesium "black flashes on label and billboard updates" ([#12231][ce12231]); labels hidden after enabling terrain ([#3545][ml3545]).
- **Collision jitter and overlap:** wrong collision boxes when pitched or rotated ([#210][ml210]); labels briefly too large during fast zoom-out ([#8175][ml8175]); overlaps during fast zoom-out ("Fade symbols faster when zooming out quickly" [mapbox #8628][mb8628]); allow-overlap symbols fading in when panned into view ([mapbox #7172][mb7172]); Native "Improve stability of symbol placement when the map is tilted" ([mapbox-gl-native #16287][mbn16287]).
- **Missing glyphs:** "Fix missing symbols/glyphs" ([Native #4554][mn4554]); Brahmic scripts "mixing fonts or dropping letters" ([#8741][ml8741]); Japanese symbols "accidentally ignored" ([#5421][ml5421]); `GlyphManager` "continually re-requesting missing glyph ranges" ([mapbox #8027][mb8027]); Tangram missing labels from a tile-load race (commit `0590820`).
- **Cost of re-placement:** "performance regression related to symbol placement" ([#4599][ml4599]); collision speedups ([#4778][ml4778], [#1757][ml1757]); cross-tile matching cost ([#7797][ml7797], [#1755][ml1755]); integer overflow in placement ([#6476][ml6476]); iOS crash with too many symbols ([#6526][ml6526]). Cesium's atlas repacks cost memory and time ([#172][ce172]); Tangram measured diagonal anchors as 11% more labels for 23% slower builds (commit `13fa0b8`).

## 6. How they test and benchmark

- **MapLibre GL JS:** 63 render-test directories for `text-`, `symbol-` and `icon-` (expected PNGs with a tolerance), run on a fake clock so a test can stop 80% through a cross-fade (`symbol-cross-fade`, `fadeDuration` 100 and `wait` operations); query tests on rendered symbols; unit tests for `placement`, `collision_index`, `grid_index`, `cross_tile_symbol_index`; Vitest benchmarks `placement.bench.ts`, `collision_index.bench.ts`, `symbol_layout.bench.ts`, `cross_tile_symbol_index.bench.ts` on a real vector tile.
- **MapLibre Native:** the same render-test suite and expectations with per-platform metrics files; C++ unit tests for `glyph_manager`, `local_glyph_rasterizer`, `cross_tile_symbol_index`, `shaping`, `quads`.
- **Tangram:** Karma unit tests; visual regression with the external Differ tool, for which a debug flag suppresses fade-in (commit `84fd5ea`).
- **CesiumJS:** Jasmine specs that render one frame (`LabelCollectionSpec`, `TextureAtlasSpec`) and check pixels or atlas coordinates.
- **OpenLayers:** 16 rendering cases with "declutter" in the name, compared to expected images.
- **deck.gl:** render tests for `text-layer` and `collision-filter-extension` against golden images; `text-auto-wrapping.bench.js`.

No project tests flicker or fade smoothness across real frames, or sharpness at several device pixel ratios; they test single frames.

## 7. Chosen approach and why

1. **Glyphs:** SDF glyphs generated in a worker with `@mapbox/tiny-sdf` (BSD-2) on an `OffscreenCanvas` (Chrome 69, Firefox 105, Safari 16.4; worker `fonts` from Safari 15), from local or consumer-supplied font files, or loaded as prebuilt PBF glyph ranges served by the consumer. CJK and other scripts not covered fall back to a local font rendered locally, at 48 px as MapLibre and Native ended up doing. Worker generation keeps the main thread free, which MapLibre (main-thread `GlyphManager`) does not.
2. **Atlas:** one shared atlas per font setting; glyphs are packed in batches and existing glyphs never move when the atlas grows (Native and deck.gl show this works; Cesium's repack-everything design is the counterexample). See open question 1 on the packer.
3. **Collision:** screen-space boxes in an `rbush` (MIT) tree rebuilt per placement pass. Labels are tried in priority order, lower MapLibre `symbol-sort-key` first, ties broken by the stable feature id, so the result never depends on input or tile-load order (Tangram's build-order rule made layouts nondeterministic). Labels behind the horizon or off screen are excluded before collision (MapLibre [#4802][ml4802]). Implemented in `packages/layers/src/label-placement.ts`.
4. **Stability:** placement runs at most every 300 ms (MapLibre and Native) and at once when labels are added or removed; between passes the decisions stay. Per-label opacity moves toward its decision at a constant rate over a 300 ms fade on the engine clock (MapLibre's length), so a visibility change is a fade, never a single-frame pop. No advantage is given to labels already visible: it would make a pass depend on the previous one, and the fixed pass interval plus fades already stop flicker (open question 2 keeps it as an option if the frame-differencing test shows swaps). Anchors are projected every frame by the renderer, so labels never lag the map. Time-slicing a pass under the per-frame budget comes with the browser measurement of F359: a 10,000-label pass takes 20–30 ms warm in Node.
5. **Testing:**
   - Node unit tests for collision, priority ordering, tie-breaking independent of input order, horizon exclusion and fade curves on a fake clock (`packages/layers/src/label-layer.test.ts`).
   - Browser tests with the debug collision boxes asserting that no two visible boxes overlap after each placement.
   - Frame differencing over a scripted pan and zoom on the engine clock: no label's opacity changes by more than one fade step per frame (catches pops and flicker), fades complete in 300 ms.
   - Sharpness measured on screenshots of text at 8, 16, 32 and 64 px and DPR 1, 2 and 3 (edge width in pixels against a threshold), plus a missing-glyph check on Latin, CJK, Arabic and Devanagari strings.
   - A placement benchmark against `quality/budgets.json` (MapLibre-style, on a dense label set).

## 8. Open questions

1. **Atlas packer (evidence contradicts the plan):** `potpack` packs a known set of boxes at once; adding glyphs means repacking, which moves existing glyphs. MapLibre uses it only for per-tile atlases that never grow. Growth without re-layout needs a shelf packer: `@mapbox/shelf-pack` (ISC), as Native does, or deck.gl's append-rows scheme. Proposal: shelf packing for the shared atlas, `potpack` only for a one-shot initial batch.
2. **R-tree versus grid:** MapLibre and Native use a uniform grid because placement alternates query and insert, which is `rbush`'s slowest pattern (bulk load does not apply). Keep `rbush` (simplest, supports mixed sizes and picking queries) and switch to a grid only if the placement benchmark misses budget.
3. **Hysteresis versus determinism:** not adopted for now (point 4): an advantage for previously visible labels makes a pass depend on the previous one, not only on the input. Revisit only if the frame-differencing test (F360) shows labels swapping during slow motion.
4. **Fade duration:** the fade equals MapLibre's 300 ms, the same as the placement interval, so a label never sits half-faded while a new pass reverses it; check against fast zoom-out overlaps in the browser test.
5. **Canvas readback noise:** TinySDF reads pixels with `getImageData`; anti-fingerprinting modes (Firefox `resistFingerprinting`, Brave, Safari advanced protection) can noise them. Reuse the distortion probe from the workers survey and fall back to PBF ranges or a bundled font file.
6. **Pixel snapping:** snapping static labels to whole pixels sharpens them but wobbles during pans (Tangram). Proposal: snap only when the camera is at rest; decide from the sharpness and frame-difference tests.
7. **Complex scripts:** shaping (Arabic, Indic) is outside this survey; the missing-glyph failures above suggest an M10 test set for it.

[green]: https://steamcdn-a.akamaihd.net/apps/valve/2007/SIGGRAPH2007_AlphaTestedMagnification.pdf
[ml]: https://github.com/maplibre/maplibre-gl-js/tree/49f780a03846d1d810316c3a5b5446617e197e94
[mn]: https://github.com/maplibre/maplibre-native/tree/d2efacc09fcf888a5e76f8eede4268aa23483765
[tg]: https://github.com/tangrams/tangram/tree/f24f47cdfa825fb4d20b639730ce2f384e2e76c4
[ce]: https://github.com/CesiumGS/cesium/tree/0c09769c7570131fef452e2af1688538ca383917
[ol]: https://github.com/openlayers/openlayers/tree/73c527cd47863d526fee5e50ccec9831082e61b7
[dg]: https://github.com/visgl/deck.gl/tree/ce528a4074ee813ac4f6b9b0e7976935519ac3f7
[ts]: https://github.com/mapbox/tiny-sdf/tree/81da9d8c66bbaa55018296d00cc1f11755a0e004
[ml210]: https://github.com/maplibre/maplibre-gl-js/issues/210
[ml1755]: https://github.com/maplibre/maplibre-gl-js/pull/1755
[ml1757]: https://github.com/maplibre/maplibre-gl-js/pull/1757
[ml2447]: https://github.com/maplibre/maplibre-gl-js/pull/2447
[ml2990]: https://github.com/maplibre/maplibre-gl-js/issues/2990
[ml3006]: https://github.com/maplibre/maplibre-gl-js/pull/3006
[ml3545]: https://github.com/maplibre/maplibre-gl-js/pull/3545
[ml4599]: https://github.com/maplibre/maplibre-gl-js/pull/4599
[ml4778]: https://github.com/maplibre/maplibre-gl-js/pull/4778
[ml4802]: https://github.com/maplibre/maplibre-gl-js/issues/4802
[ml5421]: https://github.com/maplibre/maplibre-gl-js/pull/5421
[ml6476]: https://github.com/maplibre/maplibre-gl-js/pull/6476
[ml6526]: https://github.com/maplibre/maplibre-gl-js/pull/6526
[ml7360]: https://github.com/maplibre/maplibre-gl-js/issues/7360
[ml7797]: https://github.com/maplibre/maplibre-gl-js/pull/7797
[ml8175]: https://github.com/maplibre/maplibre-gl-js/pull/8175
[ml8208]: https://github.com/maplibre/maplibre-gl-js/pull/8208
[ml8741]: https://github.com/maplibre/maplibre-gl-js/issues/8741
[mb6166]: https://github.com/mapbox/mapbox-gl-js/pull/6166
[mb6497]: https://github.com/mapbox/mapbox-gl-js/pull/6497
[mb7172]: https://github.com/mapbox/mapbox-gl-js/issues/7172
[mb8027]: https://github.com/mapbox/mapbox-gl-js/issues/8027
[mb8628]: https://github.com/mapbox/mapbox-gl-js/pull/8628
[mn3198]: https://github.com/maplibre/maplibre-native/pull/3198
[mn3534]: https://github.com/maplibre/maplibre-native/pull/3534
[mn3610]: https://github.com/maplibre/maplibre-native/pull/3610
[mn4304]: https://github.com/maplibre/maplibre-native/pull/4304
[mn4373]: https://github.com/maplibre/maplibre-native/pull/4373
[mn4554]: https://github.com/maplibre/maplibre-native/pull/4554
[mbn16040]: https://github.com/mapbox/mapbox-gl-native/pull/16040
[mbn16287]: https://github.com/mapbox/mapbox-gl-native/pull/16287
[mbn16432]: https://github.com/mapbox/mapbox-gl-native/pull/16432
[tg454]: https://github.com/tangrams/tangram/issues/454
[tg467]: https://github.com/tangrams/tangram/pull/467
[ce172]: https://github.com/CesiumGS/cesium/issues/172
[ce2094]: https://github.com/CesiumGS/cesium/issues/2094
[ce7730]: https://github.com/CesiumGS/cesium/pull/7730
[ce8474]: https://github.com/CesiumGS/cesium/issues/8474
[ce9767]: https://github.com/CesiumGS/cesium/issues/9767
[ce12231]: https://github.com/CesiumGS/cesium/issues/12231
[ol9466]: https://github.com/openlayers/openlayers/pull/9466
[ol11592]: https://github.com/openlayers/openlayers/pull/11592
[dg7337]: https://github.com/visgl/deck.gl/pull/7337
[dg8255]: https://github.com/visgl/deck.gl/pull/8255
