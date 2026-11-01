# Follow-up ideas

Ideas beyond `PLAN.md`'s scope go here, not into the code (`PLAN.md`, Working method: Scope). Each entry: the idea, why it could matter, and where it came from.

| Idea                                                                                                                        | Why                                                                                                                                                                                                                                                                     | Source                                                  |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Upgrade to TypeScript 7 (native compiler)                                                                                   | Much faster type checks                                                                                                                                                                                                                                                 | ADR 0002, once typescript-eslint and TypeDoc support it |
| In-browser area builder for offline packages (estimate, license check, resume)                                              | Lets device-mode apps build packages without the CLI; `PLAN.md` puts the builder in the CLI tools and the package API only installs, lists, updates and removes                                                                                                         | Feature-list review, session 1                          |
| Fresher imagery mosaic from raw Copernicus Sentinel-2 data                                                                  | Newer imagery than the 2016 cloudless mosaic; `PLAN.md` marks it optional and it is a large remote-sensing job (cloud masking, mosaicking)                                                                                                                              | Feature-list review, session 1                          |
| OpenStreetMap raster tiles from the pipeline                                                                                | `PLAN.md` says "if useful"; needs a server-side renderer and a style                                                                                                                                                                                                    | Feature-list review, session 1                          |
| Loading engine assets (workers, WebAssembly) from a CDN or another origin                                                   | Some hosts may want a CDN; the owner chose same-origin only for now, with a configurable base path                                                                                                                                                                      | ADR 0015 (decision 11)                                  |
| Paid cloud device service for the hardware and browser matrix                                                               | Wider device coverage than the owner's hardware; the owner declined it for now and will be asked again before M15                                                                                                                                                       | ADR 0015 (decision 2)                                   |
| Remove three.js's per-frame garbage (about 5.6 KB per frame: render-object cache keys, uniform update ranges, render lists) | The last source of garbage-collection events in steady motion; would let F064 hold with no GC event at all                                                                                                                                                              | ADR 0018                                                |
| Reuse a host's canvas element after a released WebGL2 context, through `WEBGL_lose_context.restoreContext()`                | KB-059 and KB-063 replace the element, so a host's own listeners, inline styles and framework bindings on it are lost when it mounts again (React StrictMode in development); restoring the context would keep the element (tenth M2 review, ADR 0021 §3)               |
| A typed error up front for an OffscreenCanvas that cannot take the new renderer's context                                   | An OffscreenCanvas cannot be replaced, so one that held the other backend's context or a released WebGL2 context fails inside three.js with an unclear error; `canvasFits` could report it as `renderer-failed` before init (second incremental M2 review, ADR 0021 §3) |

- **Upload pacing on slow frames (M3).** Uploads drain within a per-frame budget, so where frames are slow (the software GPU draws a 200-tile tilted view in about 1 s) the pinned base takes one frame per tile or two and `ready` waits accordingly. Consider draining uploads between frames when the frame rate drops far below the display rate, measured on the reference devices.
- **A transcoder URL apart from the worker's (M3, ADR 0020).** The transcoder loads from next to the worker program (`assets.wasmBaseUrl`'s default); hosts that serve WebAssembly from another path of their origin need the option passed to the worker. Also from ADR 0020 rule 5: separate upload-cost averages for compressed and uncompressed uploads, once the upload queue estimates costs (a compressed tile uploads 3–6 times faster on the software GPU).
- **Tile record recycling (M3 review, finding 6).** Imagery tile records and their key-map entries are never freed, and `dropUnwanted` walks every record each frame; CPU per frame and memory outside the budgets grow with very long sessions (handles also collide past 2^22 records per layer). Recycle records of unloaded tiles that no frame wants, keeping their RAM-tier entries keyed consistently.
- **Memory-pressure response (ADR 0007, M3 plan §3).** The error multiplier that rises ×1.05 per frame while admissions are refused, the `memory-pressure` event and the reservation of predicted bytes at dispatch are not built; no feature entry requires them. Refused tiles now wait 1 s and come back from RAM (KB-073).
- **A drag step at the globe's edge on an 800 × 600 page (M3 CI, unconfirmed).** On CI's software WebGPU, F060's second drag, started at 95 % of the globe's radius on an 800 × 600 page, left the grabbed point exactly one step (25.25 px) away and never caught up, on two attempts; the same test passes locally at that size and on CI at the default page size, so F060 keeps its default size. To investigate: run F060 at 800 × 600 on CI with the camera logged per step, and check whether `dragCamera` rejects a cursor point that grazes the limb.
- **Zero allocation in the frame loop with tiled imagery and terrain (M4, measured).** F064 covers the base globe; with terrain and tiled imagery in steady state (everything loaded, a small drag in a circle, the fake renderer) the frame loop allocates about 256 bytes per frame: doubles boxed across calls V8 does not inline (ADR 0018), in `screenDistance` (returned to `drawImagery` and `drawTerrain`), the `priority` argument of `ImageryLoader.want`, the selection's per-tile relief range, and `displayedHeightMeters` / `layerHeight` in terrain collision. Passing these through `Float64Array`s, as the elevation queries now do (KB-076), would bring it to zero; a test like `frame-allocation.test.ts` over `terrain-globe.test.ts`'s fixture terrain, warmed up until every tile has loaded, measures it.

## Data pipeline track (`packages/tools`)

- **Faster raster tiling for full builds:** about 0.1 s per 256-px tile on one core (Italy at z14 is about 130,000 imagery tiles, a few hours). Options: tile in worker threads, reuse row latitudes, sample whole tile rows per source raster.
- **World terrain from COG overviews:** `world-low` downloads every GLO-90 file (upper bound 248 GB, about 100 GB of land files) to build zoom 0–8; HTTP range reads of the COGs' overview levels would cut that to a few GB.
- **Streaming OSM reader for the planet:** the three-pass reader keeps the needed nodes in typed arrays (about 16 bytes per node; Italy needs about 2 GB). The planet (`world-low`, zooms 0–6, places and major roads only) needs a disk-backed node index.
- **Multipolygon buildings:** OSM relations (multipolygon buildings and building parts) are not read yet; only closed ways become buildings.
- **Smaller Terrarium tiles:** tiles keep the 1/256 m step even though the DEM's accuracy is metres; quantizing to 1/16 m before encoding would shrink them considerably without visible relief change.
- **Bordered terrain tiles (258 px):** decide after M4's crack sweep (ADR 0024, survey open question 1).

## Parallel-track review

- **`vibeglobe-data pack` writes the package manifest (PT-24).** Packages built by the CLI get their integrity checks from `createManifest`, which the publisher runs on the built file (`docs/guides/offline.md`, "Building packages"). Writing `<name>.json` next to the archive in the CLI (id, version, area, source entry, file and chunk SHA-256) would save that step and keep a consumer from hashing bytes it already received. From the parallel-track review.

## Data layers track (`packages/layers`)

- **Cluster diffs in the worker, applied in slices:** a zoom change that adds about 70,000 cluster items takes about 0.7 s on the calling thread in Node (ADR 0029). Move the per-zoom diff into the worker-pool task and apply it over several frames before F375 and F389 are measured.
- **Time-sliced label placement:** a 10,000-label pass takes 20–30 ms warm in Node; split passes across frames under the per-frame budget when F359 is measured in the browser.
- **Composite style expressions on the GPU:** zoom-and-feature expressions are re-evaluated per feature on every zoom change; MapLibre evaluates both bracketing stops and interpolates in the shader. Worth it if F370's frame times show the cost on large layers.
- **Incremental cluster updates for live feeds:** supercluster cannot update in place; a clustered live layer rebuilds its index (throttled) through `setData`.
- **Cluster bounds across the antimeridian:** `boundsOf` returns west–east in degrees without wrapping, so a cluster straddling ±180° reports bounds spanning the world.

## Atmosphere track (`packages/renderer/src/atmosphere/`)

- Hillaire-style transmittance and sky-view LUTs behind the same `Atmosphere` interface, if the per-pixel march misses the tablet budget (ADR 0040).
- A sun disk and halo in the sky when sun lighting is on (Filament's analytic disk); stars on the night side.
- Multiple scattering and ozone absorption for brighter, bluer twilight (single scattering only today).
- Night lights texture on the dark side, faded with altitude (OpenGlobus).

## Vector tiles and 3D Tiles track (M13 computational parts)

- **Right-to-left and complex scripts in labels:** the shaper lays glyphs out left to right from their advances (ADR 0041). Arabic, Hebrew and Indic scripts need bidi reordering and contextual shaping (MapLibre loads an RTL plugin for this; HarfBuzz in WebAssembly is the complete option).
- **Balanced line breaking:** labels break greedily at `text-max-width`; MapLibre balances line lengths, which looks better for two-line place names.

## Sources (M7)

- **Crop rectangle in the imagery decode task:** WMS adapters request a gutter around each tile and crop it in their transport by re-encoding the image (F231 works this way). An optional crop rectangle in the decoder description would crop in the worker's decode instead and save the re-encode (track B hook request, 2026-10-22).

## A. UI, GIS and framework adapters track

- **Minimap footprint near the horizon:** when any edge of the main view shows sky, the minimap outlines the whole visible cap (the horizon circle). A tilted view up to the horizon could instead combine the ground part of its edges with the horizon arc.
- **One attribution list:** until the engine can leave its attribution to an application control (track A hook request 1), the UI's `AttributionControl` repeats the engine's element; once it lands, the control should become the only list.
- **UI bundle budget:** `@vibeglobe/ui` is at 24.4 of its 25 KB gzip budget; further controls could move to entry points of their own (`@vibeglobe/ui/draw`, `@vibeglobe/ui/tools`) so applications load only what they add.
- **Drawing on touch screens:** vertex handles are hit within 12 CSS pixels; the reference tablet (owner question 2) may call for a larger touch radius and for a long-press to delete a vertex.
- **One host limit for wrapped and plain sources:** the network pool groups an offline-wrapped tile under `vibeglobe-tile://<host>`, not the real `https://<host>`, so a wrapped and an unwrapped source on the same real host each get the host's limit (M8 fix check, 2026-10-24; low impact: applications wrap every source of a host or none).
- **Quota warning code (track G, F511):** when a write fails with QuotaExceededError and making room fails with it too, the offline engine warns with code `storage-unavailable` (message naming the QuotaExceededError) instead of `quota`. Applications that branch on the code would read a full disk as missing storage; the code could stay `quota` while the store keeps working from memory.
- **Pops under network faults on WebGPU (track G, F510):** CI's run of the raster chaos scenario on WebGPU counted 6,308 popped pixels (first at frame 1303, top row), WebGL2 none. F510 does not ask for pop-free frames under faults (F315's network suite does, without corrupted responses); worth a look whether a corrupted or truncated tile reaches the screen for a frame on WebGPU.
- **Keyboard panning in the Playwright test context:** an arrow key on the focused map canvas pans the playground opened directly with `chromium.launch()`, but not in pages opened by the e2e helpers (`openGlobe`, with or without the UI, with or without reduced motion; 2026-10-24, found while extending F438). F406's keyboard check runs in 2D over terrain and passes; find what differs before relying on arrow keys in new specs.
- **Test guard misses an emptied spec (main session, 2026-10-25):** `npm run check:tests` passed while `e2e/robustness/network-chaos.spec.ts` had been truncated to 0 bytes (its tests are registered by helpers in `support/network-chaos.ts`, so their titles live there). The guard could compare the Playwright `--list` of each spec with the previous commit's. Found and restored before merging.
- **A package update keeps its old credit (M8 fix-check, 2026-10-25):** the offline engine caches each package's credit by package id and clears the cache only when the package reader is set, so a new version of a package under the same id whose attribution changed shows the old credit until the page reloads. Clear the entry when the manager installs or replaces a package.
- **Europe package assets in the pipeline (Europe preset, 2026-10-26):** `europe.json` builds the imagery, terrain and vector tiles, but the package's `manifest.json` is written by hand with `createManifest`, and for offline-only use the mirror of OpenFreeMap's Liberty style, TileJSON, fonts and sprites (`openfreemap/`, `docs/guides/europe-preset.md`) is copied by hand. A pipeline step could write both, once the licence of the style's fonts and sprites is recorded (the hosts were unreachable from the build machine).
- **Measured sizes of the Europe vectors and terrain (2026-10-26):** `estimate europe.json --measure` could not reach `btrfs.openfreemap.com` and `download.mapterhorn.com` from the build machine, so those rows use the configured sizes; run it where they are reachable and update `bytesPerTile` from the result.
- **A budget for dragging over vector roads (KB-210, 2026-10-26):** `benchmarks/run.ts` has the `drag-vector-roads` scenario, but it is in no budget: on the software GPU its first frame takes longer than the runner waits. Measure it on the reference desktop and add `cpuFrameP95Ms`/`frameTimeP95Ms` for it to `quality/budgets.json`. Remaining main-thread costs in its profile: re-draping meshes after terrain uploads (about 1.5 ms per frame, capped at 4 ms) and per-frame label style evaluation and allocation.
- **Raw EPSG:4326 sources on Web Mercator tiles (KB-232, 2026-10-28):** the engine draws one texture per layer and surface tile, so a Mercator surface tile across a geographic tile's edge shows the smallest geographic tile holding it whole, up to 32 times coarser along 45° N. The Europe preset asks its Blue Marble's WMS for one image per Web Mercator tile (`latitudeRows`); an app's own 4326 WMS can do the same, a 4326 tile pyramid cannot. A general fix would draw two geographic tiles per draw (split at the edge's latitude) or reproject 4326 tiles in the worker.
- **Hillshade in the workers (2026-10-30):** hillshade and color-relief images are made on the main thread (KB-242 made them once per tile and paint); a tilted view with many DEM tiles still spends main-thread time on new tiles. The vector workers could shade the DEM they already decode.
- **A halo that follows the distance (2026-10-30):** `glow` is fixed in kilometers, so applications fade it with the range themselves (the space background guide shows how); an option with a near and a far range could do it in the shader.
- **Zoom in filters (2026-10-30):** `['zoom']` in a vector filter is the tile's whole level, so a fractional limit switches where the next level's tiles are drawn (the vector tiles guide says so); evaluating filters at the camera's zoom would need layout per frame, so a documented limit may be enough.
- **Land cover warped off the main thread (2026-10-30):** `warpInBrowser` reprojects a single image (`singleImage`, the Landscape's land cover) per tile on the main thread: `getImageData` on a GPU canvas takes up to 100 ms, so zooming the Landscape below level 7 still drops frames the first time (KB-244's measurements). An `OffscreenCanvas` in the workers, or tiles cut ahead of time, would remove it.
- **Day and night on vector layers (2026-10-31):** `dayNight` (F647) shades the surface's imagery only; vector tile meshes (water, land cover fills, hillshade) have no atmosphere at all, not even its haze, so a map drawn with them keeps its water lit on the night side. The vector material could take the atmosphere's night share and airlight as the surface does.
- **Code review of 2026-10-31, items left (owner's request to clean up and speed up the code):** found by the review
  and not changed, each needing more than a small fix or a decision:
  - _Memory on weak devices:_ the imagery tile table never shrinks (a record per tile ever wanted); the data-layer
    image atlas (2048², eager) and the label atlas (4096²) start full size and re-upload whole; after a switch to the
    'none' or 'fxaa' anti-aliasing the renderer's multisampled target stays allocated (creating the renderer without
    MSAA and drawing `msaa4` through a 4-sample pass would free it); decoded imagery bitmaps are all kept for
    device-loss recovery.
  - _Main-thread work:_ a hover change repaints every vector layer (even styles without `feature-state`); picking runs on
    every `pointermove`; symbol layers evaluate their style per label per frame; composite data-layer styles
    re-evaluate every feature each frame of a zoom; GeoTIFFs go TIFF → PNG → bitmap; plain raster tiles are read back
    with `getImageData`; `deepenFallbackSkirts` is quadratic in the fallback draws after a jump.
  - _Correctness, rare:_ polar cap tiles of span 2 or more never stitch (`terrain-stitch.hot.ts` ignores `span`);
    render extensions keep their depth path after a recovery that switches backend; a rate-limited source's
    `RateRing` stays in the page-wide pool after its layer is removed; servers ignoring `Range` make PMTiles and
    package chunks download the whole file per request.
  - _Simplifications:_ `UploadQueue` could key by record slot and drop its own map and free list (about 250 lines);
    `Residency` and `RamTier` have members only tests use; PMTiles and MBTiles imagery build the same source object;
    the Google 2D and Street View providers repeat the session retry; `bookmarks` and `layer-switcher` repeat a
    disclosure; the vector and raster materials repeat their draped placement.

## Europe to zoom 15 (2026-10-31, ADR 0182)

- **Endpoints to confirm from an open network:** Denmark (a Dataforsyningen WMS in EPSG:3857, with a free token),
  Slovenia (GURS DOF025), Slovakia (GKÚ), Latvia (LĢIA) and Bremen have open licences; read their capabilities, or let
  `wmsImagery` take EPSG:4258 or a projected system through `transforms` (F227), and add them as records.
- **Italy from AGEA's open downloads:** AGEA's 2022–2024 imagery (20 cm) is reported CC BY 4.0 since 2026-08-26, as
  downloads only. A pipeline source for it would let an application host Italy's tiles in its own package.
- **BKG from 2027:** the federal DOP20 is announced as open from 2027-01-01; it would cover the four Länder left out.
- **CORS of the new services:** none could be checked from here; try each from a page once the hosts are reachable.

## Camera fits (2026-10-31, ADR 0184)

- **The package's sea keyed when it is built (KB-303):** the pipeline knows the composite's 1° cells and the land, so
  it could write the sea transparent (WebP with alpha) and the decoder would need no land outline or color test; it
  needs a rebuilt package. Until then the lakes of the land outside Europe's countries (Turkey, North Africa) are keyed
  with the sea: `EUROPE_LAND` holds only Europe's countries.
- **Requester-pays pricing without a source (ADR 0185):** since the Sentinel-2 cloudless reader is gone, no source type
  sets `requesterPays`; the estimate's `requesterPays*` prices and fields (`packages/tools/src/estimate.ts`, the
  configurations' `prices`) could go, which changes every shipped configuration file.
