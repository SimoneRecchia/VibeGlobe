# Progress

## 2026-11-01: map data is the application's responsibility; online imagery of your choice in the playground (F683)

The sources guide and the README now say that VibeGlobe grants no right to map data: the application chooses its
sources, holds their keys and keeps to their terms. The playground's Europe preset reads `VITE_ONLINE_IMAGERY_URL` and
`VITE_ONLINE_IMAGERY_CREDIT` from a never-committed `.env.local` (now in `.gitignore`) and adds that imagery worldwide
from level 12 to 19 above the free sources, so a developer can try a keyed service (MapTiler, Esri, …) under their own
plan while the offline package stays the light free one.

## 2026-11-01: no Google adapter, no Sentinel-2 cloudless; any provider from the application (F679, ADR 0185)

After an audit of the connected maps (every default source allows commercial use), the owner removed what no default
uses: the Google adapters (2D tiles, Street View, Photorealistic 3D Tiles, their fixtures, scenario, specs and live
steps) and the pipeline's Sentinel-2 cloudless reader, whose only accepted edition EOX now reserves to its commercial
licence. Applications connect any provider from their own code: a transport adds keys and sessions, a profile declares
the required credit and logo, `displayOnly` and the forbidden loading features (sources guide, "Commercial providers,
from your own code"). Fifteen entries superseded by F679 and F680 (`docs/feature-changes.md`).

## 2026-11-01: rows that pass through a panel, terrain switched off at any tilt (F677, F678, owner's request)

An application's panel editor laid its rows at the phase that held the most panels, often half a row off the tables an
aerial image showed: `layoutPanels` takes an `anchor`, a panel center its rows pass through (F677). Its terrain
switch flattened the relief by moving the relief band out of reach, but a tilted view raises the relief by itself
(ADR 0034), so the terrain stayed at 45°: `ViewCurves.maxRelief` caps the relief any zoom or tilt shows, and 0 keeps
the surface flat (F678). The core entry stays under its budget after a trim: shared mesh-vertex writers, pure block
formats, one Web Mercator latitude helper and a shared pool acquisition.

## 2026-11-01: fits frame beside a panel, in one movement (F676, owner's request)

An application with a detail panel over the map's left framed an asset across the whole canvas and then eased it
beside the panel: the zoom overshot and the view slid sideways. `fitBounds` and `fitObjects` now take `paddingPx` per
side (`{ top, right, bottom, left }`, MapLibre's shape, `ScreenInsets`): each zoom tried aims so the framed middle
shows at the middle of the part the padding leaves, measured on screen from how it moves for a step east and north at
its height (tilt and parallax counted), and the zoom found is the largest where everything shows inside that part. The
follow-up of #91 is done.

## 2026-11-01: open known bugs and classic engine bugs (owner's request)

The owner asked to close the open questions and known bugs, and to check other globe and map engines' classic bugs
against VibeGlobe. Open questions have none open (only owner steps remain pending). Fixed, each with a regression
test: WebGPU engines kept alive after a fast mount and destroy (TG-06: the warm-up's empty frame on a renderer released
while it compiled pinned it to three.js's shared quad geometry; 120 rapid cycles stay flat and F517 on WebGPU is back in
the default run), a runtime filter change over 1 s on CI (TD-02: only the changed vector layers are laid out again),
KB-221 (already fixed by KB-290, its mark removed), F474's count of cancelled requests (KB-206), vector tiles that
retried 401, 403, 410 and CORS failures every 5 s (KB-313, MapLibre #8733's class), and heightmaps turned to spikes
where fingerprinting protection adds noise to canvas readback (KB-314, MapLibre #3110: read through a `VideoFrame`
there, the worker's budget kept by removing duplicate code), a fast zoom out that dropped the orthophotos in one or two
frames (KB-309: a zoom out no longer counts as motion for motion-aware detail), and an anisotropy change that an idle
view never applied (KB-315: the refilter now asks for its frames). `main`'s full CI run after #91 failed seven shards;
the causes were tests left behind by owner decisions (F383 and F128 under the flat relief of KB-293, F409's fill since
KB-285, F440 read before its tiles were drawn, KB-206's status wording) and KB-315. Checked and unchanged
(`docs/follow-ups.md`): resize during a GPU loss, and 204 or empty tiles. Open question 39 still needs the owner (the
hosts are refused). Also fixed: `main`'s flaky allocation test (KB-312): V8 compiled the test's own driver, then engine functions, inside
the sampled frames, because the single warm-up call had been optimized in place; the warm-up now runs in several calls
and lets the background compiler finish, a window over the limit gets a second one, and the wheel zoom's step no
longer crosses a call as a double, which boxed it every frame (18 runs in a row pass, 2 of 4 failed before). And F609's measured cost of the space background since #93 (KB-317): the controls listened
for `moveend` with the tilt policy off too, which made the engine request every drag frame from inside the previous
one, so the benchmark sampled frame intervals; they listen only while an API movement runs (F609: about 0 ms again).
The CI-pace rows, reproduced with the whole browser on one CPU core: KB-241's wheel tests waited behind
frames a software GPU drew at 1280 × 720 (480 × 360 canvases now, and F438 a 6-minute limit), KB-240 was fixed by #93's
path preloading, KB-208's WebGPU slowness is its uploads (a follow-up). Still open: KB-110 and KB-212 (not reproduced,
passing in CI), KB-180, KB-181 (the owner's desktop views).
`main`'s full runs after #101 and #103 then left: the terrain baselines KB-302 had changed (recorded again, #102), the
offline matrix recording a still camera while its flight was under way on a slow machine (KB-318), F337 after #100
removed its profile, KB-185's test limit, and F101 on WebGPU, where three.js submitted every tile's mipmaps alone: a
frame's tile mipmaps now share one submit (KB-319), and an 81-tile burst uploads in 11 to 13 frames instead of 15 to 23.
KB-110 and KB-212 closed on CI's record: F137's WebGL2 sweep passed 70 full runs in a row with 0 pops, and F367 62 of
62 since KB-203's fix (the engine idle before labels were drawn), the day after KB-212's only failure. The nightly
benchmarks job recorded nothing since 2026-10-28 (git refused its checkout, KB-320): fixed. Still open, and the owner's:
question 39 (the hosts are refused here, also to a web fetch), KB-180 and KB-181 (the exact views).

## 2026-11-01: Slovenia joins the orthophotos (F675)

GURS DOF025 (CC BY 4.0) is asked from its WMS layer `SI.GURS.ZPDZ:DOF025_3857`, confirmed in a public application
built on it. Lithuania stays out on conflicting licence readings; Schleswig-Holstein and Valle d'Aosta wait for their
layers (open question 39).

## 2026-11-01: Slovakia and Bremen join the orthophotos (F674)

Two services of open question 39 were confirmed from independent sources and added: Slovakia's GKÚ Ortofotomozaika
(WMS layer `1`, EPSG:3857, CC BY 4.0) and Bremen's DOP20 2023 with Bremerhaven (two WMS layers, CC BY 4.0). Slovenia,
Lithuania (an ArcGIS cache whose levels start at 7), Schleswig-Holstein and Valle d'Aosta still wait for their layers.

## 2026-11-01: Bologna's orthophotos, Italy read a third time (owner's request)

Italy's regions still publish no orthophoto service open for commercial use, AGEA's CC BY 4.0 imagery is downloads only,
and Valle d'Aosta's 2024 flight (CC BY 4.0) has no layer readable from here. The city of Bologna's tile server
(2017–2026, level 21, CC BY 4.0 in its specification, ODbL on its open data page) joined `europeOrthophotos()` within
the city's box (F673, `OrthophotoRecord.box`).

## 2026-11-01: map changes fade in time, no blinking in motion, movements load ahead (owner's request, branch `smooth-imagery`)

Measured first with the Europe preset's fixtures (each source the base image in its own tone) in a 960 × 640 view with
400 ms latency on a 1.5 MB/s link, frames read at 60 Hz, before and after on the same machine. A layer's fade by zoom
now changes no faster than once in 600 ms (F670), and only a change of role or slot cuts cross-fades short (KB-307). The
blinking had three causes: an overlay's first tile faded in through black, a quarter darker halfway (KB-304); a layer
with nothing resident over new ground was missing until its tiles came behind every visible one (KB-305: its ancestor
four levels up now comes first); and a tile appearing by refinement where its parent showed what lies below, or two
levels finer as a camera stops, popped (KB-306). Movements plan their tiles (F671, replacing the destination and
look-ahead preloads): the destination with its ancestors first, the path's views in time order, a coarse margin ring,
terrain, and layers the destination shows though hidden at the start (KB-308). The controls' smoothed zoom gives the
view it heads for to `NavigationApi.preloadView` (F672; its browser step is still to write).

| Scenario (fixtures, 400 ms, 1.5 MB/s)          | Before                            | After               |
| ---------------------------------------------- | --------------------------------- | ------------------- |
| Zoom 4 → 12.5 in 1.5 s: largest step per frame | 10.6 (base image alone 1.9)       | 2.3                 |
| Zoom 12.5 → 4: largest step per frame          | 13.0                              | 15.2 (KB-309, open) |
| Ease pan at zoom 13.5: orthophoto missing      | 56 frames, up to 59 % of the land | none                |
| Same pan: blocks darker than both tones        | 12,736 block-frames               | 0                   |
| Drag pan at zoom 13.5: orthophoto missing      | 2.0 % of land-frames, up to 30 %  | 0.8 %, up to 20 %   |
| Flight from zoom 13, last 1.5 s: missing       | 41 % of the land on average       | 7 %                 |
| Flight from zoom 5, last 1.5 s: missing        | 40 %                              | 3 %                 |
| Wheel zoom 10 → 14: largest step per frame     | 14.6                              | 2.4                 |

A fast zoom out still drops the orthophotos in two frames: motion-aware detail coarsens the surface below their first
level (KB-309, open, with its options). Merged with main's #91 and #92, the core's main entry measured 65.37 KB gzip
on a Mac (about 65.56 in CI, Node 22): back to 64.76 by moving the heading, pitch and roll conversions, which the engine
never calls, to `@vibeglobe/core/geodesy`, by one pair of degree constants instead of thirteen, one refinement-fade
seeder and one error-message helper. An application's flight from afar to a plant with `fitObjects(…, { tiltDeg })`
was interrupted at once by the controls' tilt policy beyond its lock (KB-310): an API movement now keeps the tilt it
chose until it ends.

## 2026-10-31: one sea along the coasts (an application's screenshot of the Adriatic, branch `smooth-imagery`)

The package's sea showed rectangular steps at zoom 8 to 11: its Sentinel-2 composite has real water only in the 1° cells
holding land and a flat no-data color beyond, and from level 9 only tiles touching land, while the preset keyed out only
the flat color, everywhere (inland lakes and shadows near it too). A coverage area's `keySea` (F669, KB-303) now makes
water's colors transparent outside `EUROPE_LAND`, fading back in over 4 km inside it: a blur 1.5 times the fade
stretched fourfold, which also closes the gaps of up to 3.2 km that the countries' separately simplified borders leave
(a lake on a border would otherwise show streaks); a wide fade is blurred on a smaller canvas and stretched back. Tiles
inside the land are no longer masked (0.6 ms a tile less), coastal ones cost about 1.1 ms instead of 0.5–0.8 on a Mac,
and the edge bleed visits only pixels next to colored ones (1.65 to 0.54 ms a tile, same output). Checked in Chromium on
synthetic package tiles of the Adriatic (real water ending at 14° E, sea-only tiles at levels 9–11 drawn from level 8)
and on all-water tiles across the Alps and Lake Geneva; no committed end-to-end test reproduces the package's colors.
`e2e/europe-zoom-phases.spec.ts` passes once its package stand-in shows water as imagery (ADR 0026) rather than the
no-data color; over the coast its zoom 10 and 11 frames now reach 17.0 and 18.4 of the 20 allowed, the stand-in's
blurred coast partly keyed.

## 2026-10-31: the line along tile edges on maps with 3D terrain fixed (KB-302)

The owner saw the maps glitch with 3D terrain. On the Europe preset's Map over the fixture Alps a line one pixel wide
ran along tile edges: the meshes' skirts, twice the terrain error deep, won the depth test against the draped vector
map on part of the MSAA samples. Skirts now keep the flat globe's few meters with terrain (the frame still deepens them
where coarser terrain or a morph shows), and edges next to a coarser mesh follow its segments in the surface shader
(`stitchEdges` top bits), which closes the T-junctions the deep skirts used to hide (ADR 0006, update of 2026-10-31).
A new end-to-end test fails with 176 line pixels on the old skirts and passes now; the crack sweep, morphs and missing
terrain (F137–F139) pass on both backends. To fit the renderer's budget the GPU readback probes moved to their own entry
(`@vibeglobe/renderer/gpu-probes`): the main entry fell from 40.46 to 37.97 KB gzip and its budget to 38.5 KB.

## 2026-10-31: three more orthophoto services, Italy read again, a terrain seam found (owner's request)

The owner asked for the missing free and resellable maps of Europe to zoom 15, Italy first, and for the glitches seen
with 3D terrain. The provider hosts are refused by the container's proxy, so terms came from search quotes and
endpoints from the OSM editor layer index. Baden-Württemberg (LGL DOP20, dl-de/by-2-0 since LGL's open data), Brussels
(UrbIS Ortho, CC0, with its borders from Natural Earth's map units) and Denmark (GeoDanmark, CC BY 4.0, the
application's free key, asked in WGS84 as its WMS has no Web Mercator) joined `europeOrthophotos()` (F668). Slovenia,
Slovakia, Lithuania, Schleswig-Holstein, Bremen and Valle d'Aosta pass on licence but wait for their layer names (open
question 39). Italy has no other online service that passes: AGEA's 2022–2024 national imagery is CC BY 4.0 since
August but downloads only, the route for an application's own package. The terrain glitch reproduced on the vector Map
base: a one-pixel line along vector tile edges where the shaded surface shows through part of the MSAA samples
(KB-302); clip, depth pull and skirts were ruled out within the time box, and the next steps are recorded.

## 2026-10-31: a zoom that stops before the ground, flights that frame whole turbines and plants (owner's request)

In the owner's application a wheel zoom over terrain reached zoom 28: the collision lifted the camera's target off the
ground instead of stopping (KB-300). A zoom in now stops 40 m from the terrain under the cursor, mountains included
(`constraints.minSurfaceDistanceMeters`, F666; 0 keeps the old reach for the precision scenarios). A flight to a turbine
went to zoom 22 at its foot (KB-301): fits now aim at the middle of what they frame, keep 100 m from it and take a
tilt, and model sets give their copies' boxes (`framePositions`, F667), so `fitObjects` frames a turbine whole and
centered and a plant by its every device (ADR 0184). The orthophotos now pass through the offline engine as network
sources (KB-291), and the offline package keeps its level 11 as the owner asked.

## 2026-10-31: a lighter start for weak PCs (owner's request, branch `lighter-engine`)

An application's whole-globe start downloaded 10.7 MB. Five causes are gone, each with a regression test: a vector tile
layer requests a source's tiles only while one of its visible layers draws at the zoom (KB-292: 6.5 MB of OpenFreeMap
levels 0 to 2 whose layers start at 2 or 3); the terrain's pinned base loads only once relief is drawn, and `ready`
no longer waits for it (KB-293: about 770 KB of Mapterhorn); a hidden imagery layer loads nothing, pinned base
included, until shown (KB-294); `singleImage` with `sizePx` (or `bounds` and `maxLevel`) downloads with its first tile
(KB-295; the Europe guide now passes the land cover's `sizePx`); the worker loads the KTX2 transcoder with
its first task and Draco without its encoder, and the guides ask Vite and Nuxt applications for ES-module workers,
whose entry is 16 KB instead of the 457 KB Vite's default format inlines (KB-296); three.js's glTF loader loads with the
first model (KB-297); the land mask and country borders are stored as polyline text, a quarter of their JSON, and the
presets entry fell from 44.02 to 27.33 KB gzip (KB-298). Dead antimeridian cutters left the renderer. The style
specification's 51 KB reference table in the worker's vector-tile chunk is still whole (`latest` gives the layers their
property specifications); a trimmed table would need a generator kept in step with the pinned version.

## 2026-10-31: flights without freezes, level tables, panels read from aerial images (an application's map of devices)

An application flying to a device over detailed terrain froze twice for most of a second: the adaptive quality
stepped, the anisotropy changed and every imagery texture was made again in one task (KB-288); the tiles are now made
again four a frame. Model sets take a `footprint` (F663): each copy stands level at the highest ground under its
corners, and the playground's solar table has posts 5 m deep that meet a slope. `detectPanels` in `@vibeglobe/gis`
(F664) finds the solar tables in a top-down capture of an area with image arithmetic: blue (or, for black modules,
dark) pixels, the bearing of the sharpest stripes, rows and tables along them; about a tenth of a second for two
million pixels, checked on a real orthophoto of Prenzlau. The drawing tool found a polygon's first vertex and its
handles on the ellipsoid while the shapes lie on the terrain (KB-289), and draped polygons and lines sank into the
coarser terrain mesh from a few kilometers (KB-290). `DrawColors.fillOpacity` (F665) lightens a drawn area's fill.

## 2026-10-31: Europe to zoom 15 from open imagery (owner's request)

The owner asked for all of Europe at zoom 15 from free sources that allow commercial use and redistribution. Every
country's orthophoto services were read again (ADR 0182, amendment of 2026-10-31), with credits composed from each
licence's own rule where the provider fixes none and free keys accepted. Fifteen services joined
`europeOrthophotos()` (F661): France, Spain, the Netherlands, Flanders, Wallonia, Luxembourg, Alto Adige, Bayern,
Hessen, Sachsen, Hamburg, Finland (with the application's key), Estonia, Poland and Croatia, each clipped to its
borders (Belgium's regions and Bolzano's province were added to the generated borders) and asked for up to level 18 to 21. No Europe-wide source passes (Copernicus VHR is for eligible users, EOX is non-commercial), and Italy, the United
Kingdom, Ireland, Scandinavia but Finland, most of the east and the Balkans have no open service: there the package's
10 m WorldCover is the detail, now readable to the level it was built to (`packageLevels.imagery`, F662). The
exclusions were shortened, so the presets entry fell to 44.06 KB.

## 2026-10-31: panels laid out in rows, and a grid on the ground (an application's editor)

F658 and F659 in `@vibeglobe/gis`, pure functions for an application's editor of solar parks. `layoutPanels` places
identical rectangles in rows inside drawn perimeters, around fixed panels, at the wanted positions where known, all
shrinking alike when room runs out; a scanline per row keeps it fast for every drag. `gridLines` gives the segments of
a ground grid turned to the rows' bearing. `DrawLayers` and `DrawInput` are exported from `@vibeglobe/ui` (F660), so
the editor's own pen drives the drawing tool. Unit tests cover the first two; the editor's browser steps are pending.

## 2026-10-31: the same engine with less code (owner's request)

The owner asked for the same results with less code. Copies that had drifted apart were written once: the growth of
typed-array tables (five places), the controls' velocity fit, the LZW decoder and TIFF value reader (sources and tools
each had one; core's `decoders` entry now holds them), the vector-tile target's types (declared in core, layers and
the renderer), the PMTiles and MBTiles imagery sources, the package storage's IndexedDB access, the conformance
suite's fault checks, the two tile-mesh builders and the imagery stack's entries. The tools package uses Node's
`crc32` and the `pmtiles` library's directory search instead of its own. 47 files, about 400 lines fewer; the core's
main entry fell from 64.86 KB to 64.48 KB gzip. Changes that would grow the renderer's bundle (a shared mesh setup) or
pass doubles as call arguments on a per-frame path (ADR 0018) were left as they are.

## 2026-10-31: the open questions answered, and a lighter first download for the playground (owner's request)

The owner asked the agent to answer the questions still open itself and do what follows (ADR 0183). Most needed no
change: the licensing texts are the standard ones, the Google key and Terrascope stay out, a release pushes to `main`
as built, the orthophoto rules stand, KB-219 is closed as fixed, and the agent's earlier decisions are confirmed. Open
question 37 took option (b): fog-aware detail must request fewer tiles whose center lies in full fog (6 against 73 on
WebGL2, 8 against 76 on WebGPU), the total only logged, which ends KB-230's CI failures; F574 is superseded by F657.
The playground's page loaded the Europe preset, the Mont Blanc builds, a consumer's adapters and the render experiment
on every visit; they now load only on the pages that use them, and the first download fell from 153 KB to 104 KB gzip.

## 2026-10-31: a second look at the code added since the review (owner's request)

The changes merged since the code review (#80 to #83) were read again for waste on weak machines. Two per-frame costs
are gone: a vector map draped on the terrain walked every terrain tile kept several times a frame to read the terrain's
counters (KB-286), and a model set standing on the ground built the globe's whole camera state every frame (KB-287).

## 2026-10-31: the turbine without a mast on its nacelle (owner's request)

The wind sensors' mast and the red aviation light on the nacelle's roof are gone: the turbine has 1,850 triangles and
56 KB. F649, which gave 1,880 triangles, is superseded by F656 (`docs/feature-changes.md`).

## 2026-10-31: data layers over vector maps, flat polygons that blend (bugs from an application)

KB-284 and KB-285. An application's translucent rings under wind turbines disappeared on its flat road map: polygon
layers were always built as extrusions (the specification's default height of 0), drawn opaque before every
translucent layer and with `fill-opacity` ignored, and a vector map made after them drew over them in any case, since
the engine draws in scene order. A polygon is now extruded only when its style sets a height, and a vector map's group
joins the scene before the data layers' meshes.

## 2026-10-31: a flat map that never loads terrain, and six needs of an application in the library

An application's flat road map lagged while zooming over a country with its roads on. A CPU profile at a quarter of a
fast laptop's speed showed three costs the flat view did not need: the engine wanted terrain for every tile although
the relief drew every height at 0 (KB-281: about 170 DEM tiles at each move), vector meshes sampled the terrain under
every vertex (KB-282), and tiles waiting for their mesh built text keys for every ancestor of every layer each frame
(KB-283). With all three fixed, the long tasks while zooming fell from about 850 ms to 60–330 ms per move and the
vector layer's frame time from about 45 ms to 16 ms at that speed.

Six needs of the same application, which had built them itself, are in the library now. `mercatorImage`
(`@vibeglobe/sources`, F650) serves levels 0 to `maxLevel` of one Web Mercator image of the world, decoded once.
`TierCounters` (`@vibeglobe/offline`, F651) give the bytes per tier, and `Offline.countTransport` counts a transport
outside the tiers. A vector tile layer reads where its style placed the labels of a layer by a feature property
(`labelAnchors`) and keeps chosen labels placed without drawing them (`setLabelsHidden`, F652). `Globe.geoToScreen`
reports `behindGlobe` (F653). The controls gain the gesture switch `skyDragPan` and `forwardWheel(element)` for HTML
over the map (F654). A `ModelSetLayer` with `ground: globe` stands its copies on the terrain as drawn, from the
terrain in memory, and `markerPosition` puts an HTML marker on a model's top under any relief (F655). Unit tests
cover all six; their browser steps are pending.

## 2026-10-31: a wind turbine and a solar table for the energy park (owner's request)

The owner asked for a detailed but light wind turbine whose rotor turns at an adjustable speed and whose nacelle turns
on its tower, and for slightly tilted solar tables, both able to run by the thousand on weak machines. Both models are
generated from original geometry by `scripts/models/build.ts`: a three-blade turbine of the 2 MW class (80 m rotor on a
78 m conical tower, streamlined nacelle, egg-shaped spinner, twisted and tapered blades; 1,880 triangles in three meshes,
58 KB) and a 2P × 12 fixed-tilt table at 20° on steel posts (188 triangles, one module texture repeated, 20 KB). Model
sets gained moving parts (F648): `spin` and `yaw` turn named glTF nodes per copy inside the same instanced draws
(`ModelSetOptions.joints`), with speeds eased at runtime and frames asked for only while a turning part is drawn; the
renderer pays for it by sharing the single models' placement and picking code with the sets (40.30 KB, from 40.31).
`?scenario=energy-park` shows ten turbines behind 720 tables with sliders for the rotors' speed and the wind (F649).

## 2026-10-31: code review for bugs, less code and weak devices (owner's request)

The owner asked for every package to be reviewed for bugs and dead weight, and for the engine to run on weak
machines. Four reviews in fresh contexts covered core, renderer and controls, layers and sources, and the other
packages; each finding was checked against its callers and fixed with a failing regression test first. 35 bugs are
fixed (KB-246 to KB-280), among them: imagery layers swapped at runtime overflowing their texture handles after about
510 swaps; an offline-mode miss stopping every tile beyond the pinned base; empty 204 answers taken for corrupt tiles;
data layers drawn in build order instead of their own; vector meshes, anti-aliasing passes, model textures and late
IndexedDB connections never freed; a drag stuck after a lost pointer capture; labels past the 1024th hidden in their
first pass; a worker cluster index dead after a detach; GeoTIFF tag and DEFLATE bombs; captive portal pages stored in
packages. For weak devices: adaptive quality now recovers on 60 Hz screens, adapts under 4 fps and caps each preset's
pixels per CSS pixel (ADR 0122 amendment); the sky is drawn after the globe's tiles, so it no longer ray-marches under
them; queued tiles are dropped from the queue alone instead of a scan of every tile the session ever saw; label caches
and GeoJSON tiling no longer grow or cost quadratically; WebGL2's vertex array cleanup no longer splits every key.
Less code: dead members of the priority heap, the upload queue, the network pool (per-host rates, unclaimed results)
and the controls (a rotation switch always on) are gone, the surface draw state holds its nine textures in one array,
and the Vue and web component adapters share one click watcher. The core's main entry is 64.79 KB, the renderer's
40.32 KB. Items needing more than a small fix are listed in `docs/follow-ups.md`.

## 2026-10-31: day and night like a map application, and a clearer globe from afar (targeted owner request)

From an application's report (F647). `AtmosphereSettings.dayNight` (0 to 1) dims and tints the side away from the Sun
across a soft terminator about 14° wide and leaves the day side as the imagery shows it; an imagery layer with
`blend: 'night'` (code 3) is added as light on the night side only, after the lighting, so a city-lights image glows
over a dark, blue-tinted night. Values between fade it; the sky's Sun turns from behind the eye toward the real one as
it fades, so the haze never jumps. `airlight` (0 to 1) scales the light the air scatters over the ground: the physical
amount veils the disk in milky blue from afar. In an application with NASA's Black Marble as Web Mercator tiles 0 to 4,
`dayNight` faded at a zoom and `airlight` 0.5, the globe showed night and lights at the real time with a soft band, ran
at 60 fps while turning and crossing the fade's zoom, and kept deep colors by day. The renderer's entry grew to 40.17 KB:
its budget is 40.5 KB (`docs/test-changes.md`). The guides (space background, sources), ADR 0038 and the packages' notes
describe it; `CLAUDE.md` gained notes on Playwright runs and local baselines.

## 2026-10-30: vector meshes within a frame budget, paint per layer, halos fading with their text (bugs from an application)

KB-244 and KB-245. Zooming from 3.2 to 6 over a country with the borders overlay stalled the page for 340 ms at level 5,
where the region borders appear and every tile's mesh was built and draped in one frame, and for about 100 ms at later
levels, where every mesh was repainted for the new zoom pair. Meshes are now built and repainted within 6 ms per frame,
one at least, the rest drawn meanwhile by the kept mesh of a tile around or inside them; a mesh whose new zoom pair
waits is drawn with its own (`VectorDraw.zoomT`). A paint change repaints only its layer and visibility nothing. The
same zoom runs at 60 fps with no long task. `text-opacity` now fades the halo too. Over imagery the borders are a light
grey that recedes into the picture. The Landscape's land cover warp on the main thread is a follow-up.

## 2026-10-30: guides and notes for the day's work (documentation)

The guides cover what the day added: the tilt policy's `fullTiltBelowMeters` and a tilt slider on `controls.maxTiltDeg`
(controls), camera limits with `maxRangeMeters` against `minZoom` (controls), the halo and how to fade it with the
range (space background), runtime switching instead of new layers, zoom in filters and hillshade cost (vector tiles),
the Landscape's overlays and their layer ids, hiding a country's name, copying the map's label paint, and a Blue Marble
base image with its polar caps (Europe preset). `CLAUDE.md` and the packages' notes record the CI size margin, the line
limit, the preset guide's example count, feature entries that cannot be reworded, squash-only merges, release packing
and the local PMTiles timeouts; three follow-ups are listed.

## 2026-10-30: a farthest range for the camera, hillshade over terrain, name faces (targeted owner request)

From an application's report (F646, KB-242, KB-243). `constraints.maxRangeMeters` limits how far the camera goes at
the same distance at every latitude: with `minZoom` alone a drag toward a pole moved the camera in. Hillshade and
color-relief meshes no longer follow the terrain's version or the zoom in their keys: the terrain refreshes their
ground in place, so a tilted Landscape view with terrain went from 14 to 54 fps; its hillshade now stops at zoom 11.
The preset's names take the style's faces (countries bold, water italic) instead of its first, italic, one.
The core stays within its budget: the constraints' bounds reuse `validateBounds` (the same check, the same
'invalid-coordinate' code) instead of a copy of it, which more than pays for the new limit.

## 2026-10-30: a Landscape map and borders, country and sea names as overlays (targeted owner request)

A map like a virtual globe's for an application that wants few labels (F644, F645). `landscape` draws OpenFreeMap's
land cover in soft greens and whites from level 7, light blue water and a light hillshade; farther away an app's land
cover image (`landCover`, for example NASA's MODIS land cover recolored, the guide says how) shows under the water and
the land color covers it from level 7 to 8. Borders (countries, regions from level 5), country names and sea names are
overlays of their own over Satellite and Landscape, dark on the map and light on imagery; `styleFor` takes a language
for the names. Unit tests cover the layers, levels, fade, order, ink and language; in an application the Landscape
showed from the whole globe to Rome, with Italian names and no jump at levels 7 to 8. The presets' entry is 44.6 KB of
its 45.

## 2026-10-30: a halo around the globe seen from space (targeted owner request)

For a far view in an application's own look (F643): the space background takes `glow` (0 to 4, default 0, so nothing
changes for others), a soft blue halo beyond the limb drawn by its full-screen backdrop from the height above the globe
where each ray passes closest: a bright edge falling by e over 60 km and a wide part over 320 km, whitish at the edge
and deeper blue farther out, on the day side only while sun lighting is on. The renderer's main entry is unchanged
(the starfield is its own entry). A unit test covers the option; in an application with the Blue Marble base image,
`glow: 1` and no Milky Way, the halo showed from 23,000 and 38,000 km, softened over the physical sky's thin rim, and
followed the terminator with sun lighting on.

## 2026-10-30: the tilt policy's cap over a chosen range, and the largest tilt for a slider (targeted owner request)

For a tilt slider in an application (F641, F642). `tiltPolicy.fullTiltBelowMeters` (default half the lock, as
before) sets where the policy's cap ends: from 0° at the lock it rises continuously in the distance's logarithm, so
an application with a far lock tilts more and more while zooming in. `controls.maxTiltDeg` reports the largest tilt the
view allows now: the empty-sky limit, the constraints' `maxTiltDeg`, the
policy's cap, or the tilt terrain clearance holds the camera at while it does; the engine writes it into the
tilt policy array (`[5]`; `[4]` now carries the cap's range in octaves), so the core's main entry stays within its
65 KB budget (two redundant NaN guards before comparisons went too). Unit tests cover the option, the cap
range and the terrain hold; in an application with a lock at 100 km and the full tilt at 5 km, an 80° tilt chosen at
59 km rose with the cap (3.6° to 74.6° from 59 to 12.5 km) and reached 80° at 8.8 km, and the cap followed a terrain
hold at 2.6 km.

## 2026-10-28: Europe preset Satellite tones, the package's box, the sea, terrain 404s (targeted owner request)

Five defects the owner saw in an application with `europeOpen()` Satellite and the package, fixed with tests (F638–F640,
KB-234–KB-238; F636 superseded). (1) The blue-gray land from level 5 to 14 was WorldCover and the online sources
matched to the darker Blue Marble at every zoom: a layer's tone match now fades out by zoom (`harmonizeFade`, the
measured gain to the power of a strength 1 → 0, gone by level 9) and never darkens; the online sources and the
orthophotos are never matched. (2) The edge at European Turkey: WorldCover now covers the package's whole box with a
soft edge, its level 8 tiles magnified where deeper levels hold Europe's land only. (3) The tone jump at zoom 3.5–5
and (4) the blotchy, striped sea beyond level 8 were the Blue Marble: with a package it is left out, and the sea is
the base image at every level (online only, the Blue Marble stays). (5) Terrain asks for no tile below one its loader
knows missing: one 404 a tile of the first missing level remains, which the browser logs itself
(`onlineMaxLevel: { 'europe-terrain': 13 }` removes them). `e2e/europe-zoom-phases.spec.ts` now expects WorldCover's
own tone from zoom 8 and zooms 3 to 9 in steps of 0.1; views before and after at the report's zooms, on a Blue Marble
stand-in (`earth-marble`), show the cast, the jump and the sea's blotches gone.

## 2026-10-28: Europe preset Satellite by zoom, tones across layers, Italian orthophotos (targeted owner request)

Problems the owner saw in an application with `europeOpen()` Satellite, fixed with tests (F630–F637, KB-231–KB-233). Far away
(levels 0–4, `farLevels`) the globe's base image shows again, as before #57; NASA's Blue Marble fades in over half a
level (`fadeIn` by zoom, F635), then the package's WorldCover over a level on Europe's land, its flat no-data water
keyed out everywhere and its land outside Europe faded out over 12 pixels (KB-231, KB-233); above level 11 the app's
online sources and the orthophotos fade in over a level, each to its own deepest level. Layers match the tones of the
imagery below them, measured cell by cell where both show (`harmonize: 'below'`, F633). The pixelated rows were the
Blue Marble drawn as EPSG:4326 tiles: a Mercator tile across 45° N showed level 1 (KB-232); it is now one WMS image
per Mercator tile with rows linear in latitude. A chain starting deeper than level 0 pins its first level within its
coverage, a level per layer in turn (F634). `e2e/europe-zoom-phases.spec.ts` zooms 0 to 16 over Italy's land, coast
and sea on fixtures drawn from the base image in three tones: every settled frame within a block difference of 20
of the base image alone (13.7 at most), steps of 0.1 level as smooth as the base image's own motion, no hole. The
core's polygon areas moved to `@vibeglobe/core/coverage` to keep the main entry within its 65 KB budget. Research:
no Italian orthophoto passes the criterion online yet (`docs/research/italy-orthophotos.md`, ADR 0182, open question
38).

## 2026-10-27: tilt policy, terrain clearance, progressive roads and model sets (targeted owner request)

Requests from integrating the engine in an application with wind and solar farms. (1) F625: an optional tilt policy of
the controls by the distance to the point looked at (`tiltPolicy`, `setTiltPolicy`; 20,000 m lock, automatic tilt
from 2,000 m to 60° at 500 m), applied by the engine each frame so API tilts are capped too; `tiltAvailable` and
`onTiltAvailabilityChange` disable the UI's 3D button; the playground's showcase has it on (`?tiltPolicy=1`
elsewhere). Off by default: on, it would change every existing view the end-to-end suite encodes. (2) KB-219, the camera entering the terrain, was not reproduced on the fixture terrain in any movement (open question
36); hardened as asked: the terrain under and ahead of the eye loads first, and the smooth rise to late terrain is
kept by the eye across movement frames. The core budget went from 64 to 65 KB (owner). (3) F626: the preset's roads by class from levels 6, 9, 11, 13
and 14, names from 13. On the fixture tiles (OpenFreeMap is not reachable here; the fixture z12 tiles hold 41 roads)
a drag's main-thread time per frame barely moves: z8 with roads p50 3.5 → 4.0 ms, z12 with roads 5.2 → 5.1 ms. (4)
F627: `ModelSetLayer`, one model for many copies, instanced, the model within `visibleBelowMeters` (3,000 m) and a
placeholder beyond, nothing out of view; 2,000 turbines cost 4 draws near the farm and 1 from 14 km
(`?scenario=wind-farm`), and a models guide (`docs/guides/models.md`). The WebGPU variants of F146 and F147 time out
on this container's software GPU and were left to CI.

## 2026-10-27: Europe preset styles, satellite chain and north-up limit (targeted owner request)

Problems the owner found with the Europe preset in an application, fixed as KB-214 to KB-218 with regression tests
(F621–F624). Map is a political map (neutral land, water, borders, names; roads an overlay off by default); Relief is
that map over a `color-relief` tint, now drawn by `@vibeglobe/layers`, and the hillshade. The satellite chain is NASA's
Blue Marble from GIBS (EPSG:4326, up to level 7, filling the polar caps), the package's WorldCover from 5 to 11, then
the orthophotos from level 12, whose white tiles count as no data; Map and Relief give the caps their own colors.
Terrascope's WorldCover WMTS is left out: its terms do not clearly allow free commercial use (open question 35). The
first source of a chain that starts at level 0 is now the pinned base, so far views are sharp at once; a second lap
at 3000 km has no blurry tile. 'north-up' stops at a configurable latitude, 85° by default. The package goes to
level 11 (owner), and the guide has the WorldCover package's size per deepest level, measured on real tiles of six
areas: 0.58, 2.20, 7.93 and 27.0 GB for levels 10 to 13. Not done, as the hosts are blocked here: each orthophoto
service's real minimum level and which ones stay broken (open question 34 (c)); no service was removed. The core
bundle is 4 bytes under its 64 KB budget after trimming messages.

## 2026-10-26: polar caps and navigation modes (targeted owner request)

Two problems found integrating the engine in an application. (1) KB-211, the North Pole showed as a light-blue crescent beside striped tiles: every view mode flattens into the Web Mercator plane once zoomed in (ADR 0008), and the plane cannot show the caps beyond 85.05° (a band ending at the pole, nothing beyond it, stretched wedge tiles), while caps without a geographic source showed the equirectangular base image's stretched polar rows. A view that reaches a cap now stays a globe, and such caps show a fill color (`polarCapColors`, `setPolarCapColors`; F619). (2) Navigation modes 'free' (default, trackball over the poles, heading turns) and 'north-up' (heading held, stops at 89.9°) through `createControls({ navigationMode })` and `controls.setNavigationMode` (F620, ADR 0009 update), with a playground selector and a section in `docs/guides/controls.md`. Pushed to the same pull request as the earlier requests of the day (#56), which the owner merges.

## 2026-10-26: the Europe preset (targeted owner request)

A map of Europe in the style of Google Earth from free sources that may be redistributed commercially, for hybrid use: the application's offline package up to a chosen level, with online detail on land beyond it. Engine gaps filled: polygon coverage areas of imagery and terrain sources (F610), package-only and network-only sources (F611), vector style credits shown with the imagery's (F612). Source chains (F247) and Terrarium terrain were already supported. New package `@vibeglobe/presets` with `europeOpen` (F613, ADR 0182; the national orthophotos are left out until their terms can be read, open question 34). Also the pipeline configuration `europe.json` with a Natural Earth land mask and a separate sea level (F614), `estimate` with land and sea counts and `--measure` (F615), the guide `docs/guides/europe-preset.md` (F616), and the playground's `?preset=europe` selector (F617). One pull request, which the owner merges.

## Handoff (written 2026-10-27, before an account change)

The owner continues from another account. Branch `claude/wizardly-archimedes-up4ww2` is restarted from `main` after
each merge; everything is merged into `main`: pull requests #26 to #58 (squash merges; #41 superseded by #43, to
close). Since the last handoff (2026-10-25) four targeted owner requests came from integrating the engine in the first
consumer (an application with wind and solar farms on the globe), each one pull request:

- #55 (F610–F617): the Europe preset `@vibeglobe/presets` (`europeOpen`): Satellite, Hybrid, Map, Relief and overlays
  from free sources that allow commercial use, ADR 0182 with every source's terms; `europe.json` for the offline
  package; guide `docs/guides/europe-preset.md`.
- #56 (F618–F620, KB-209–KB-211): source areas as GeoJSON clipped per pixel and `blankTile`; faster drags over vector
  roads; eleven national and regional orthophotos (`@vibeglobe/presets/orthophotos`); polar caps as a continuous disc
  with `polarCapColors`; navigation modes 'free' and 'north-up'.
- #57 (F621–F624, KB-214–KB-218): political Map and Relief with an elevation tint (`color-relief` in
  `@vibeglobe/layers`); satellite chain NASA Blue Marble (GIBS, EPSG:4326, fills the caps) → package WorldCover (z5–z11)
  → orthophotos from z12 (white tiles are no data); Terrascope left out (question 35); package to z11 (owner); the
  WorldCover package size table in the guide (z10 0.58 GB, z11 2.20 GB, z12 7.93 GB, z13 27.0 GB); north-up latitude
  limit (85° by default); a chain's world source pinned so far views are sharp at once.
- #58 (F625–F627, KB-219): the controls' tilt policy (`tiltPolicy`, `setTiltPolicy`, `tiltAvailable`; opt-in, on in
  the showcase); terrain clearance hardening (terrain under and ahead of the eye loads first); the preset's roads by
  class from levels 6/9/11/13/14, names from 13; `ModelSetLayer` (instanced copies of one model, a placeholder beyond
  `visibleBelowMeters`, nothing out of view; `?scenario=wind-farm`, guide `docs/guides/models.md`). The core bundle
  budget is 65 KB (owner, 2026-10-27); core is at 64.38 KB.

**State.** `npm run status`: 467 passing, 80 failing, 33 pending (owner steps), 22 superseded, 80.5% of the 580
active entries. M1, M2, M3 and M9 are complete; in M4–M14 every failing entry is in `docs/hardening-backlog.md`; M15
is 10 of 53. `npm run status` names F137 (M4) next.

**Open problems from the first consumer** (what the next session should pick up first):

1. KB-219, the camera entering the terrain while zooming: not reproduced on the fixture terrain (every movement keeps
   the eye 10 m above the drawn surface); hardened only. Question 36 asks the owner for the view, terrain and device.
2. The national orthophotos: each service's real minimum level, and which ones still answer white or empty tiles, could
   not be checked (the providers' hosts are blocked in the cloud environment); all start at level 12 meanwhile.
   Question 34 (c).
3. ESA WorldCover online from Terrascope: excluded until VITO confirms free use from a commercial product (question 35).
4. Progressive roads: measured only on the fixture tiles (a z12 tile holds 41 roads), where a drag's main-thread time
   barely moves (z12 with roads p50 5.2 → 5.1 ms). Measure again on OpenFreeMap's real tiles (z8 and z12, with and
   without roads) once its host is reachable or on the owner's machine.
5. The tilt policy is opt-in: on by default it would change every existing view. The owner decides whether
   `createControls()` should turn it on by default (then the end-to-end specs that tilt by API at high altitude need
   updating, logged in `docs/test-changes.md`).
6. Models: the renderer reads them with three.js's `GLTFLoader`; meshopt and Draco work once the application gives the
   decoders (`docs/guides/models.md`), KTX2 textures do not yet; hook request C (2) of `docs/parallel-tracks.md`
   (meshes built from `@vibeglobe/models`' `ModelDescription`) is still open.
7. The WebGPU variants of F146 and F147 time out on the cloud container's software GPU: check them in the next full CI
   run.

**Open bugs** (`docs/known-bugs.md`, all "Open"): KB-219 (above); KB-180 and KB-181 (terrain near the poles and a crack
at level 14, waiting for the owner's exact views); KB-110 (F137's crack sweep pops once on CI's software GPU); KB-097
and KB-170 (M5 relief and tilt in the descent onto a flank); KB-203, KB-206, KB-207, KB-208, KB-212 and KB-213 (flaky
or unreproduced on CI, M15 hardening); TG-01, TG-04 and TG-06 (track G). KB-097, KB-110 and KB-170 may stay open until
the hardening weeks (ADR 0046).

**The full suite on CI.** Not run on `main` since #53 (the last full run, 40224392533, passed every job but one F081
retry). First job: dispatch `ci.yml` on `main` (eight shards), and fix what it reports by reproducing it in CI's image
(`CLAUDE.md`), until one run is green.

**Hardening backlog in priority order** (`docs/hardening-backlog.md` has every entry with what remains):

1. The first consumer's open problems above, then KB-180 and KB-181, F137 and F148 (crack sweep, KB-110).
2. The globe-to-street zoom: F167 and F157 (KB-097, KB-170).
3. Data layers on real GPUs and terrain: F363 to F366 (clamping, draping, morph), F351 to F354, F361 (hook C (2)),
   F371 to F375 and F389, F379.
4. Vector tiles and 3D Tiles: F440, F444, F445, F451, F452, F455, F463, F470.
5. Atmosphere and anti-aliasing on real GPUs: F391, F392, F394, F397.
6. Adaptive loading and network modes: F286 to F288, F293 to F295, F300, F301, F315, then F329.
7. M15: TG-01, TG-04, TG-06 and the remaining M15 entries (cross-browser F504, soak, chaos, fuzzing, the WebGL2 CPU
   p95 of `drag-200/400/800` on the owner's Mac, the release).

**Open owner questions** (`docs/open-questions.md`): 13 (legal review of the README licensing text), 16
(`GOOGLE_MAPS_API_KEY` as a CI secret), 17 (the npm token and the `npm-release` environment), 34 (orthophoto evidence,
credits, per-service levels), 35 (Terrascope), 36 (KB-219's reproduction); the `v0.1.0` tag of the pre-release commit
`04f9286` is the owner's to push (`npm run release:pack` rebuilds the 0.1.0 tarballs, `release-0.1.0/README.md`). The 33 pending entries wait for the owner steps listed there.

**Cloud environment.** The network policy blocks the providers' hosts (OpenFreeMap, Mapterhorn, GIBS, Terrascope, the
orthophoto services): tests route them to fixtures. Allowing them under the environment's network access settings
would let a session check the orthophotos and measure the roads on real tiles.

**Start of the next session.** Read this, run `./init.sh`, dispatch the full CI run on `main`, ask the owner for the
first consumer's newest findings and the answers to questions 34–36, then follow the order above.

## Track I, space background (2026-10-25, branch `claude/vibrant-wright-9kiyj6`)

Owner requirement of 2026-10-24: an optional space background like Google Earth's, off by default (ADR 0181). `main`
carries the main session's entries F600–F606 for it; the track added F607–F609 (`docs/feature-changes.md`).

- `packages/renderer/src/starfield/`: `addSpaceBackground(globe, options)` (`@vibeglobe/renderer/starfield`), a render
  extension: the 9,096 stars of the Yale Bright Star Catalog (public domain; MIT JSON conversion; recorded in
  `THIRD_PARTY_NOTICES.md`), an engine asset `bsc5-stars.bin` fetched when first drawn (`catalogUrl`), drawn as Gaussian
  sprites with a 0.75 device-pixel floor and pixel-ratio-independent light, and a procedural Milky Way in galactic axes
  (no image). Sky orientation by precession and Greenwich mean sidereal time from `Globe.atmosphere.timeMs`; fades under
  the daytime sky near the ground. Guide `docs/guides/space-background.md`.
- Playground `?stars=1` (`&starCatalog=<url>`; handle in `window.vibeglobeStars`). Tests: three unit files in the folder;
  `e2e/starfield.spec.ts`, `e2e/starfield-motion.spec.ts` (0.5 px per-frame tracking, flicker, seam and poles, fade,
  lazy asset, guide), `e2e/starfield-cost.spec.ts`; helpers in `e2e/support/starfield.ts`.
- Status: F600–F604, F606–F609 passing; F605 pending its GPU-time step on the reference desktop (`docs/open-questions.md`).
- Hook requests I (1)–(6) in `docs/parallel-tracks.md`.
- Notes: `geoToScreen` scales heights by the relief factor (0 at globe scale), so it cannot project far points; the e2e
  predictions fit the camera from ground points instead. On CI's software GPU the background costs about 10–15 % of the
  frame rate (per-triangle setup of the 9,096 sprites); its main-thread cost is under 0.1 ms.

## Track I, space background (2026-10-25, branch `claude/vibrant-wright-9kiyj6`)

Owner requirement of 2026-10-24: an optional space background like Google Earth's, off by default (ADR 0181). `main`
carries the main session's entries F600–F606 for it; the track added F607–F609 (`docs/feature-changes.md`).

- `packages/renderer/src/starfield/`: `addSpaceBackground(globe, options)` (`@vibeglobe/renderer/starfield`), a render
  extension: the 9,096 stars of the Yale Bright Star Catalog (public domain; MIT JSON conversion; recorded in
  `THIRD_PARTY_NOTICES.md`), an engine asset `bsc5-stars.bin` fetched when first drawn (`catalogUrl`), drawn as Gaussian
  sprites with a 0.75 device-pixel floor and pixel-ratio-independent light, and a procedural Milky Way in galactic axes
  (no image). Sky orientation by precession and Greenwich mean sidereal time from `Globe.atmosphere.timeMs`; fades under
  the daytime sky near the ground. Guide `docs/guides/space-background.md`.
- Playground `?stars=1` (`&starCatalog=<url>`; handle in `window.vibeglobeStars`). Tests: three unit files in the folder;
  `e2e/starfield.spec.ts`, `e2e/starfield-motion.spec.ts` (0.5 px per-frame tracking, flicker, seam and poles, fade,
  lazy asset, guide), `e2e/starfield-cost.spec.ts`; helpers in `e2e/support/starfield.ts`.
- Status: F600–F604, F606–F609 passing; F605 pending its GPU-time step on the reference desktop (`docs/open-questions.md`).
- Hook requests I (1)–(6) in `docs/parallel-tracks.md`.
- Notes: `geoToScreen` scales heights by the relief factor (0 at globe scale), so it cannot project far points; the e2e
  predictions fit the camera from ground points instead. On CI's software GPU the background costs about 10–15 % of the
  frame rate (per-triangle setup of the 9,096 sprites); its main-thread cost is under 0.1 ms.

## Track H, packaging and release (2026-10-24)

Branch `ccr-1bf24b9b-dyvgg5`, pull request SimoneRecchia/VibeGlobe#33 into `main` (the owner merges). Owns
`scripts/release/`, `examples/`, `.github/workflows/release.yml`, `.claude/skills/release/` and the build fields of the
packages' `package.json` (ADR 0171; numbers 0171–0179).

- Passing: F532 (core, renderer, sources and `@vibeglobe/worker/basic` install no layers, UI, offline, Vue or Web
  Component package; the globe renders and navigates; ADR 0172, made by this track with the owner's go-ahead),
  F503 (321.7 KB gzip before the first frame, budget 351 KB; six optional modules fetched only when enabled),
  F519 (`scripts/release/assets.json`, notices of data files), F526 (changelog from the history), F530 (tarballs and a
  strict consumer), F531 (Vite and Nuxt builds, assets from a separate static server, no `'unsafe-eval'`), F535 (the
  release skill, dry run followed to the end).
- Pending owner steps: F558 (the approved publish from CI), F559 (install from npm once published); question 17.
- Hook requests: H (1) done by this track (ADR 0172); H (2) `@types/three` as a dependency of `@vibeglobe/renderer` (consumers install it
  meanwhile). Known bug TH-01 (a failed transcoder load is cached for the session) is the worker package's.
- Commands: `node scripts/release/check-tarballs.ts`, `node scripts/release/check-consumers.ts [F503] [F531] [F532]`
  (`VIBEGLOBE_CHROMIUM_PATH` in cloud containers, `VIBEGLOBE_RELEASE_KEEP=1` keeps the built projects),
  `node scripts/release/release.ts <version>` (dry run), `node scripts/release/check-cube.ts`.
- About 3 hours of agent time.

## Track F, network simulation suite (2026-10-23)

Branch `claude/festive-brahmagupta-82m0hu`, pull request into `main` (the owner merges). Owns `e2e/network/`,
`scripts/fixtures/tiles/link.ts` and `scripts/fixtures/network/` (ADR 0151; numbers 0151–0159).

- F315: the navigation scenario on fully offline, 400 kbps, flaky, 500 ms latency and LAN-only links on WebGPU and
  forced WebGL2, every frame checked for holes, black pixels and pops, retries bounded with backoff
  (`e2e/network/links.spec.ts`). Stays `failing`: only frame times within budget on the reference hardware remain
  (`docs/hardening-backlog.md`, open question 2).
- F329's scenario specs, all passing on both backends: the network suite (`links.spec.ts`), connectivity dropping
  mid-pan and returning after a flight (`drop-return.spec.ts`), both offline setups in offline-only mode
  (`offline-setups.spec.ts`), and the three network modes with the loading switches all on and all off
  (`modes.spec.ts`; the full 16-combination matrix with its request and storage checks stays
  `e2e/offline-matrix.spec.ts`). F329's acceptance (known bugs, the fresh-context review) is the main session's.
- Hook requests: none.

## Current state

- **M2 Globe core complete** (F078 passing, 2026-10-21: the full CI suite green on 9679fe0, reviews closed by ADR 0021, no open bug). Passing in M2: F042–F064, F066–F074, F076–F078; pending owner steps: F065, F075.
- Also passing: F546 (initial-JavaScript budgets, start-up median 456 ms), F547 (lazy loading, `apps/lazy-host`). Pending owner steps: F065 (OffscreenCanvas measured and not adopted, ADR 0019; other browsers on real GPUs) and F075 (hardware procedure, `docs/guides/hardware-testing.md`).
- **M3 Imagery streaming complete** (F125, 2026-10-22: the full CI run green on 0f18b8b; docs/plan/m3-imagery-streaming.md). Passing: F079–F114, F116–F121, F125, F562–F564; pending owner step: F115 (start-up budget on a real GPU: 9.8 s on the software GPU of the container, docs/open-questions.md); superseded by ADR 0023: F122–F124 (replaced by F562–F564). One fresh-context review: findings fixed as KB-070 to KB-073 plus three requirement gaps; no open bug.
- M3 took about 14 hours of agent time (2026-10-21 13:20 to 2026-10-22 03:10 UTC, groundwork included): about 9.5 hours of features and 4.5 hours of making the full CI run green on its software GPU (eight single-worker end-to-end shards, isolated measurements one at a time, KB-074 and KB-075, test timing fixes logged in docs/test-changes.md). Remaining: M4 to M15, 413 active entries. Estimate to M15 at the M3 pace (about 3 entries per hour including CI stabilization): 110 to 140 hours of agent time, plus the owner-only steps in docs/open-questions.md.
- **M4 Terrain: features built, closing** (2026-10-22; docs/plan/m4-terrain.md). Passing: F126, F128, F131, F132, F134–F147; failing until their visual baselines are recorded in CI: F127, F129, F130 and the acceptance F148 (the baseline workflow's WebGL2 terrain captures time out on CI's runner, under investigation); pending owner step: F133 (a published EGM2008 grid: download and conversion are the owner's, docs/open-questions.md). Decoders run in the worker (Terrarium, Terrain-RGB, quantized-mesh with its extensions, gzip-bounded), custom decoders inline (ADR 0027), geoid-referenced sources converted with a consumer-hosted grid; the surface refines and culls by each tile's own relief, morphs relief across at most two levels (ADR 0028), deepens skirts for fallbacks, keeps the eye above the displayed and the finest terrain, and answers synchronous and asynchronous elevation queries. One fresh-context review and one pass on its fixes; bugs KB-076 to KB-092 all fixed, none open. The terrain end-to-end set (34 specs) passes on both backends with one worker; timings of F134 and F144 are gated on a real GPU only (ADR 0012).
- M4 took about 15 hours of agent time (2026-10-22 03:20 to 18:30 UTC): about 7 hours of features, 8 hours of review fixes and making the terrain scenarios hold on the container's software GPU (one worker, small canvases, settled starts). Remaining after M4: about 370 active entries, of which about 150 belong to the parallel tracks (docs/parallel-tracks.md) and are integrated, not rebuilt. Estimate to M15 for this session at M4's pace (about 1.5 entries per hour, CI stabilization included): 130 to 170 hours of agent time, plus the owner-only steps in docs/open-questions.md.
- **M5 Globe, map and 3D view: features built, closing** (2026-10-22; ADR 0008, ADR 0034): curves, GPU morph, morph-aware selection and picking, view modes with chosen and applied tilt and heading, terrain and empty-sky clamps, the phase tests (F151, F153, F154). Open: KB-097 (terrain ledge, planned fix in the worker) and KB-101 (F107 shimmer in its new view); entries are marked once the full CI run on the container is green and the visual baselines are re-recorded.
- **M6 Navigation: features complete, closing** (2026-10-23, 11:10–13:00 UTC after the merge of the input track). Passing: every M6 entry but the owner-only ones; pending the reference tablet or a real trackpad: F169, F171–F173, F180, F184–F186, and F217 once the full CI run on this head is green (its tablet checklist and frame-rate targets on the reference devices). This segment: the input hooks (orbit, engine clock, interrupt), F168, F174, F175, F177, F178, F182, F183, F187, F200, F202, F203, F209–F211, F213–F216 end to end; bugs KB-121 to KB-128 (the review's five included), each with its regression test. M6 took about 9 hours of agent time in all (engine side 5 h on 2026-10-22, integration and closing 4 h). Monday is still reachable: M7–M14 integration and M10, M11, M13 remain, about 2.5 days at the pace of M6.
- CI (ADR 0035): the browser jobs run in Playwright's image on 16 shards after one build job; the visual baselines workflow had run two tests at once, which slowed each capture from under 1 s to 20–30 s on the software GPU (the "capture hang" of M4): it now runs one at a time. Wall-clock of a full run: 54 min before ADR 0035; after: to be measured on the first green container run.
- Monday target (owner, 2026-10-22): feature-complete by 26 October 08:00 Europe/Rome. M5 and M6 took about 5 hours so far (18:30–23:30 UTC); M7–M14 integration and M10, M11, M13 remain, with parallel sessions on controls, atmosphere and M13's computational parts. Reachable if the integration milestones average about 6 hours each.
- **M7 Sources** (2026-10-23 morning): reprojection on the client (ADR 0039; F226, F227 with WMS GetMap and WMTS tile mosaics), transport security (F251–F253), credits, chains, limits. Open in M7: F249 (tone harmonization, planned per ADR 0039), and the entries listed in docs/hardening-backlog.md.
- **M10 Data layers, renderer side, in progress** (2026-10-23, from 05:45 UTC): passing now F362, F368, F369, F370, F376, F377, F381, F383, F384, F385, F386, F387, F388 (and F380 pending its tablet step); glTF models as interactive features (`@vibeglobe/layers/models`), terrain picking with elevation, fit to objects, the data layers guide; bugs found and fixed: KB-111 (taps lost), KB-112 (clamped features not picked), KB-113 (layer visibility without a frame), KB-114 (antimeridian and polar geometry), KB-115 (model layer handlers kept), KB-116 (removed meshes kept by three.js render objects, tiles included). core moved its quantized-mesh decoder to `@vibeglobe/core/decoders` to stay within its 60 KB budget (59.7 KB). Monday: M10 at about 2 features an hour leaves M8, M9, M12, M14 integration and M11, M13 for Saturday and Sunday; still reachable only if the parallel sessions' PRs (controls, atmosphere, M13) land by Saturday.
- **2026-10-23 afternoon and evening (main session):** tracks A, B and C merged into the branch; round-3 hooks for tracks D, E and F (render extensions with network and workers, `layout-vector-tile`; `parse-model` reopened for CSP, see `docs/parallel-tracks.md` C (1)); core moved geodesics to `@vibeglobe/core/geodesy` to keep its 60 KB budget. Passing now: F285, F302, F303 (adaptive loading), F260 (Google cache lifetimes), F355 (extrusions on slopes, heights within 1%), F367 (no street-level jitter of data primitives). Built with leftovers in `docs/hardening-backlog.md`: F286, F287, F288, F300 (Firefox and WebKit), F301. Hooks answered: B (2) and B (3) (display-only refusals; F323 completes with track E's 3D Tiles data access). Bugs: KB-131 fixed (detail stayed coarse after a jump); KB-132 open (allocation test fails about one run in ten). The first full CI run of the day found regressions of the adaptive-loading work (F090, F320–F324, CSP F100), fixed; F413 and F426 timed out on `main` too (flights at four frames a second), their timeout raised with the reason recorded.
- Hours: about 8 hours of agent time on 2026-10-23 after the morning (11:30–19:30 UTC). Monday (26 October 08:00 Europe/Rome) is not reachable for every entry: M10 (renderer items F358, F374, F375, F378), M11 wiring (atmosphere, quality settings) and M12's larger-than-canvas capture (F416) remain for the main session, with M13 in tracks D and E; the hardening-only leftovers wait for the two hardening weeks.
- Owner questions open: `docs/open-questions.md` 2 and 13–17; questions 18 and 19 were decided by the agent (ADR 0018, ADR 0012) and may be revisited.

## Track E: 3D Tiles (`packages/renderer/src/tiles3d`, `packages/sources/src/tiles3d`)

Branch `claude/keen-davinci-ym90tk`; entries, blockers and hook requests E (1)–(5) in `docs/parallel-tracks.md` ("E. 3D Tiles track: status"); ADR 0141.

- **2026-10-23:** Passing: F461 (no holes while streaming, both backends, slow link; debug overlay), F462 (center-first requests through the page's pool within host limits, cancellation in flights, LRU budget; the 10-minute navigation ran once), F464 (no street-level jitter, WGS84 alignment), F465 (globe, flattening, 2D and 3D phases), F466 (picking with batch tables and 1.1 property tables), F467 (no z-fighting on terrain: a 0.1% relative depth pull). Pending owner steps: F468 (run with a real key), F469 (three-hour real session). Failing with blockers: F463 (hook E (1), `parse-model` in the worker program), F470 (hook E (2), extension credits in the engine's attribution), F471 (reference devices; hook E (5), benchmark history).
- Found and fixed while building (before commit, no known bug left open): every in-flight request was cancelled each frame (a loading tile is not re-requested by traversal); rigid per-tileset placement drifted on the flat map (0.4% north–south Mercator stretch) and failed for Google's whole-Earth root: tiles are now placed by the local derivative of the frame's mapping at each tile's center (sub-millimeter); render extensions receive `network` and `workers` only on a globe with tiled imagery, so the scenarios use `imagery=world`.
- About 6 hours of agent time.

## Track B: source adapters and offline (`packages/sources`, `packages/offline`)

Branch `claude/laughing-tesla-a6tkm3`, pull request SimoneRecchia/VibeGlobe#20; entries, blockers and hook requests (1)–(5) in `docs/parallel-tracks.md` ("Track B, source adapters and offline: status").

- **2026-10-23:** Passing: F228 (custom WMTS matrix sets through reprojection), F234 (single images by bounds, world file and GeoTIFF; `@vibeglobe/sources/geotiff` ports the data pipeline's own TIFF reader with `fflate`, because the `geotiff` library brings `pako` (MIT AND Zlib) and `xml-utils` (CC0-1.0), outside the allowed licenses), F235 (terrain conformance suite), F268 (sources guide, examples run as tests), F271, F272, F290, F292, F296, F298 (network modes with flights, `e2e/offline-modes.spec.ts`), F306 (package credits), F314 (the mode and switch matrix), F316 (no telemetry), F320–F322, F324–F326 (provider profiles, `e2e/offline-profiles.spec.ts`), F328 (terrain and MVT packages). Hardening only (`docs/hardening-backlog.md`): F293, F294, F295, F315 (frame-time and first-frame budgets on real hardware, popping). After the merge of `main` (hooks 1, 4 and 5 done there): F258 and F259 pass too. Blocked on the main session: F260 (hook request 2), F323 (hook request 3); F264 needs the live run from a network that reaches the OSMF servers.
- Bugs found and fixed: TB-01 (`offline.source()` bypassed the adapters' transports), TB-03 (aborted tiles counted by the tiers), TB-04 (faint lines between composed WMTS tiles). TB-02 (renderer) fixed by the main session.
- Notes: the offline harness now mounts provider adapters, declared profiles, terrain, memory budgets and a tier overlay (`?debug`-like); flights are measured with `emptyPixelsMoving` (the camera moves between a capture and the silhouette's radius). On the software GPU a frame of a flight test costs about a second, so specs use a 320 × 240 canvas. Hybrid mode with a view past a package keeps retrying its misses and never goes idle (hook request 3 of the offline track): such specs sample settled frames instead of waiting for idle.

## Models and quality track (track C, `packages/models` and `packages/quality`)

Branch `claude/vigilant-hawking-h8r4u4`; owned entries, blockers and hook requests in `docs/parallel-tracks.md` ("Models and quality track: status").

- **2026-10-23:** `@vibeglobe/models` (ADR 0121): GLB and glTF parsing and validation, Draco (`draco3d`) and meshopt (`meshoptimizer`) decoding in a worker task, sparse accessors, node transforms and a renderer-neutral `ModelDescription`; conformance suite over eleven Khronos samples (sixteen variants), fuzzed corrupt input, decoding in a Chromium module worker (`e2e/models.spec.ts`). `@vibeglobe/quality` (ADR 0122): presets, `choosePreset`, the `FrameTimeGovernor` (median window, dead band, reaction and stable timers, minimum change interval, raise backoff) and `createQuality`, checked in Node and on the real engine (`e2e/quality.spec.ts`).
- Pending: F400 (reference desktop and tablet). Failing with blockers: F361 (hooks 1–2: worker registration, renderer drawing `ModelDescription`), F399 (hook 3: runtime level of detail and effects; reference desktop), F401 and F402 (hook 4: a real GPU load in the playground; 5-minute browser run in the hardening backlog).
- About 3 hours of agent time (2026-10-23).

## Track D: vector tile rendering (`packages/renderer/src/vector-tiles/`, `packages/layers/src/vector-tiles/`)

Branch `claude/keen-feynman-ic048f`, pull request SimoneRecchia/VibeGlobe#31; hook requests D (1)–(4) in `docs/parallel-tracks.md`; ADRs 0131 (rendering), 0132 (labels, SDF atlas and text material for F358), 0133 (raster-like layers).

- **2026-10-24:** Passing: F441, F442, F443, F446, F447, F448, F449, F450, F454, F456, F457, F458, F459. Only their `@baseline` views remain (hook request D (3), `docs/hardening-backlog.md`): F440, F444 (MapLibre's demotiles style, BSD-3-Clause, unchanged), F445 (every layer type, raster, hillshade and heatmap included), F452, F455. Blocked: F451 on hook request D (1) (engine log and `error` event for extensions); F453 on the data pipeline's Italy OpenStreetMap tiles, whose source host this environment refuses (open question 25); its checks on the fixture city pass (`e2e/vector-tiles/osm-roads.spec.ts`).
- Bug found and fixed: TD-01 (shown labels faded down every other frame). Found by F443's trace: the engine gives extensions its workers only with tiled imagery or terrain (hook request D (4)); one shader program per mesh kind removed the 50–200 ms program builds when a layer first appeared.
- Notes: the `@baseline` tests fail in a full CI run until the baselines workflow records them (D (3)). Fixtures: `node e2e/vector-tiles/fixtures/generate.ts [--tiles]`. Vite can keep serving stale modules after scripted edits: restart it before a run.
- About 14 hours of agent time (2026-10-23 and 24).

## A. UI, GIS and framework adapters track (2026-10-23)

Branch `claude/confident-ride-i2h6il`, pull request SimoneRecchia/VibeGlobe#21; entries, blockers and hook requests in
`docs/parallel-tracks.md` ("A. UI, GIS and framework adapters track: status"); decisions in ADR 0101.

- **2026-10-23:** the UI, GIS and adapter stubs are replaced with the engine's view modes (chosen and applied tilt and
  heading), terrain heights and the controls connection. New `@vibeglobe/ui` controls: 2D / 3D / Auto with Back to
  Auto, tilt, reset to globe and home, scale bar, attribution, layer switcher, geolocation, bookmarks, screenshot,
  minimap, drawing (points, draped lines and polygons, editing with mouse, touch and keyboard) and measurement;
  `addAllControls`. Accessibility audit with the IBM Equal Access engine (axe-core is MPL-2.0), reduced motion and
  layout checks with every control. Vue: live `viewMode`, `layers` and `networkMode` props, `VibeDataLayer`,
  `VibeMarker` and `VibeControl`. The element: `ui`, `theme`, `lang` and the `ui` part. The Nuxt example has a page
  per feature group with browser checks; the integration guide is in the documentation site.
- Passing: F407–F409, F411–F415, F417, F424, F426, F434, F436, F437, F475, F485. Pending (reference tablet): F406,
  F410, F421–F423, F425; pending publishing to npm (owner question 17): F555. Failing on engine work: F416 (hook
  request 4), F474 (F399), F476 (hook request 2), F488 (the groups' missing engine features).
- Notes: the software GPU's frames stay slow at 640 × 480, so the specs use that size and wait for idle; the visual
  baselines of `e2e/ui-theme.spec.ts` (F430) differ in size on this container's Chromium 141 (fonts) and pass only in
  the pinned CI image, unchanged by this track; the ui bundle is at 24.4 of 25 KB gzip.

## M6 input track (eighth session, `packages/controls`)

Branch `claude/modest-wozniak-067cfl`; owned entries, hook requests and each entry's blocker in `docs/parallel-tracks.md` ("M6 input track: status").

- **2026-10-22:** `@vibeglobe/controls` rebuilt for M6 (ADR 0009 §3–6): mouse pan, right-drag and Ctrl+drag rotate and tilt, Shift+drag zoom box, double click; wheel notches smoothed (100 ms, 2-level lead cap), trackpad scroll and ctrlKey pinch applied per frame, Safari gesture events; touch pan, pinch, twist and an exclusive two-finger tilt decided on event times, double tap, two-finger tap, re-baselining at finger changes; arrows, Shift+arrows, +/-, N, Home and view-mode keys; closed-form inertia on engine time (quartered under reduced motion); validated settings (`createControls(options)`), `zoomIn`, `zoomOut`, `resetNorth`, and `connect(globe)` for rotation and the engine clock until hooks 1–3 land. Guide `docs/guides/controls.md`. Browser specs on a harness page of the playground's dev server (`e2e/support/controls.html`).
- Passing: F170, F175, F179, F181, F183, F189. Pending (reference tablet or trackpads): F169, F171, F172, F180, F184, F186. Failing until M4, M5 and the M6 movement API reach `main`: F168, F173, F174, F178, F182, F185, F187, F213.
- Notes: on the container's software GPU an 800 × 600 frame blocks the main thread for about 250–500 ms, so pointer events arrive too far apart for the 80 ms velocity window; the inertia and touch specs use a 320 × 240 canvas (`?size=`), and `settle()` waits for 1.5 s without a frame. Chromium dispatches one pointermove per finger of a touch event with the same timestamp, and a frame can fall between them: samples with equal timestamps replace each other, and a frame waits once for a finger moving in step with the other. Animated notches cost the playground's existing wheel specs (`globe-core.spec.ts`, F061 and the warm-up test) about 2.5 frames per notch on the software GPU and pushed them past their timeouts: a zoom animation now applies in one step after two animation frames in a row came three time constants apart or more (re-measured after 5 s), and those specs pass unchanged. Release velocity is measured over the 80 ms before the last motion and dropped when the release comes more than 50 ms after it, so slow event delivery still measures the drag. Unconnected controls at rest read no clock, so the playground's idle frames allocate nothing (`globe-allocation.spec.ts`).

## Vector tiles and 3D Tiles track (eighth session, M13 computational parts)

Branch `claude/laughing-fermat-40ejeq`; owned entries, blockers and hook requests in `docs/parallel-tracks.md` ("Vector tiles and 3D Tiles track: status").

- **2026-10-22:** Survey `docs/research/vector-and-3d-tiles.md` and ADR 0041. `@vibeglobe/layers/vector-tiles`: MapLibre style loading, validation with JSON paths, runtime changes with their cost and layer cross-fades (`@maplibre/maplibre-gl-style-spec` 26.4.4); fill tessellation (earcut) and line tessellation with joins, caps and width as a paint value, clipped at the tile buffer; building heights (tags, levels, defaults by type, parts) and extrusion geometry; glyph ranges, glyph PBF decoding, font fallback, sprites, text shaping; line-label anchors and glyphs along lines, collision with priorities, cross-tile ids and fades; OSM road order and place ranking with label languages; overzoom, coverage and stand-in parents; the `layout-vector-tile` worker task. `@vibeglobe/sources/tiles3d`: tilesets 1.0 and 1.1, b3dm, i3dm, pnts, cmpt and glTF content, implicit tiling with subtrees and 1.1 metadata, traversal by screen-space error (REPLACE keeps the parent until every child is covered, ADD), request priorities and cancellation, an LRU content budget; CC0 public samples as fixtures. Passing: F439, F460. Every other owned entry waits on drawing, the engine's vector and 3D Tiles sources and playground scenarios (hook requests 1–6 of this track).
- Notes: tests run in Node only (`npx vitest run packages/layers/src/vector-tiles packages/sources/src/tiles3d`); right-to-left scripts and balanced line breaking are in `docs/follow-ups.md`; the 10-minute browser soak of F462 is in `docs/hardening-backlog.md`.

## Data pipeline track (second session, `packages/tools`)

Branch `claude/tools-offline-builder-uvuuxe`, pull request SimoneRecchia/VibeGlobe#6; status and blockers in `docs/parallel-tracks.md`.

- **2026-10-21:** `vibeglobe-data` CLI (ADR 0024): estimate with cost and confirmation, license gate, resumable steps with SHA-256 checks, built-in GeoTIFF reader, PNG, JPEG and Terrarium encoders, PMTiles and MBTiles writers, OSM PBF to MVT, GDAL only in a digest-pinned Docker image (convert hook and `verify`). Configurations `world-low`, `italy-high`, `test-mont-blanc` with lock files. Licenses re-verified (ADR 0025, `docs/data-licenses.md`), dataset-build skill, hosting guide. Verified on real Copernicus DEM (Mont Blanc) and the real Natural Earth fallback; Sentinel-2 cloudless and OSM through fixture stubs (owner question 21; Geofabrik is not reachable from the container). Browser checks: `npx playwright test -c packages/tools/playwright.config.ts`.
- **2026-10-22:** Detailed imagery switched to the ESA WorldCover 2021 Sentinel-2 RGBNIR composite (owner answer to question 22, ADR 0026): windowed COG reads with range requests, a fixed colour stretch (B04, B03, B02; `255 × min(1, r / 3000) ^ 0.5`), composite gaps filled by WorldCover land-cover class, sea at the measured median sea colour. Verified on real data: Mont Blanc sample (74 MB instead of 2.3 GB), Gulf of Naples, and the world-low sample at overview 4. Merged `main` after pull request SimoneRecchia/VibeGlobe#7.
- Passing: F330–F335, F338, F340, F343–F346, F552, F553, F307. F553's check: the playground's production build ran from a plain static server (`http-server` with CORS and ranges, Docker Hub being rate-limited for nginx), with the worker and base image under `/static/vibeglobe/` and the sample tiles; every request answered 200 and the zoom-5 frame had no empty pixel. Following the guide also showed that the unbundled worker cannot be served as is; the guide now says to serve the bundled one. Waiting on main-track engine capabilities (adapters, attribution, source chains, offline mode): F336, F337, F339, F341, F304, F305, F551, F554.
- Notes: Docker Hub rate-limits this container's pulls intermittently, and GHCR blobs are blocked, so the configurations pin `docker.io/osgeo/gdal:ubuntu-small-3.6.3` by digest. Raster tiling runs at about 0.1 s per 256-px tile on one core, and the OSM reader holds the needed nodes in memory: both are noted in `docs/follow-ups.md` for full builds.

## Data layers track (seventh session, `packages/layers`)

Branch `claude/festive-cori-5030me`; status, stubs, hook requests and waiting entries in `docs/parallel-tracks.md` ("Data layers track: status").

- **2026-10-22:** M10 surveys (picking, labels, data layers; F348–F350 passing) and ADR 0029. `packages/layers`: `LayerRenderTarget` (the draw interface) with `RecordingRenderTarget`, structure-of-arrays `FeatureStore` with dirty-run uploads, MapLibre-expression styles (`@maplibre/maplibre-gl-style-spec`), `LayerStack` with pick slots, `DataLayer`, `LabelLayer` (rbush collision, 300 ms passes and fades), `ClusterLayer` (supercluster, animated splits and merges), `InteractionController`, `GeoJsonLayer` on a stub of the M7 format adapters. 31 unit tests in Node. Every other M10 entry waits on the renderer, terrain (M4), the phases (M5) or flights (M6), listed with what each needs.
- **2026-10-22 (later):** merged `main` with the M7 source adapters (SimoneRecchia/VibeGlobe#11) and the M14 framework adapters (SimoneRecchia/VibeGlobe#13). The GeoJSON stub is replaced by `geojsonFormat`, `kmlFormat` and `gpxFormat` on the M7 parsers; their issues become error events. No entry newly passes: F371 still needs parsing in the worker pool and drawing.
- Notes: the style engine's fallback path (a property the style reads is missing) is about 20 times slower than a normal evaluation; cluster diffs and label passes still run on the calling thread (`docs/follow-ups.md`).

## Offline engine track (sixth session, `packages/offline`)

Branch `claude/gifted-mayer-p0kexd`; status, stubs and waiting entries in `docs/parallel-tracks.md`.

- **2026-10-22:** `@vibeglobe/offline` (ADR 0033): tiers in a transport wrapper (persistent cache, packages, network),
  IndexedDB cache in a dedicated worker with LRU eviction and quota handling, HTTP cache policy and ETag revalidation,
  eviction detection, persistence requests, health-check connectivity with captive-portal detection and backoff,
  network modes and switches with provider rules, the package manager (URL, local files and in-browser builds;
  integrity per chunk; versions; resumable installs), contracts for cache stores and network policies, the Docker LAN
  server, the offline guide, and the research survey. Browser specs `e2e/offline-*.spec.ts` on a harness page of the
  playground's dev server (the playground itself is the main track's).
- **2026-10-22 (after the M7 and M14 merges):** the typed stub of the PMTiles and MBTiles adapters is gone; packages
  load through `pmtilesImagery` and `mbtilesImagery`. Passing: F304 and F305 (CLI packages navigated offline-only,
  `e2e/offline-cli-packages.spec.ts`) and F336 (the build's packages pass the integrity check,
  `scripts/integration/package-outputs.test.ts`). F337, F339, F551 and F554 still wait on F254/F255, F129 and
  F247/F248.
- Notes for the next session of this track: the fixture tile server sends `no-store`, so specs rewrite cache headers
  with `tileHeaders()`; Docker's daemon is not running in a fresh container (`dockerd &`); `Globe.ready` stays pending
  in a start with the network down and no data for the pinned levels (ADR 0033, hook request 3).

## Source adapters track (fourth session, `packages/sources`)

Branch `claude/m7-source-adapters-0gkrjg`; status, contract workarounds and what each remaining entry waits for in `docs/parallel-tracks.md`.

- **2026-10-22:** Adapters on the frozen source contract (ADR 0030): PMTiles (range requests, `pmtiles` library), MBTiles (`sql.js`, `@vibeglobe/sources/mbtiles`), WMTS and WMS (capabilities, CRS choice, gutter cropping), GeoJSON, KML/KMZ, GPX and a validating MVT decoder (`@vibeglobe/sources/vector`, worker task table), Google Map Tiles API 2D and Street View with session renewal (ADR 0031), the OpenStreetMap public-servers profile (ADR 0032). Shared, framework-free conformance suites (`@vibeglobe/sources/conformance`), an opt-in live run (`npm run test:live-sources`), the survey `docs/research/source-adapters.md` and the guide `docs/guides/sources.md`.
- Passing: F223, F230–F233, F236–F239, F256, F257, F261–F263, F265–F267, and F341 of the data pipeline track. Pending the owner: F549 (one live run with the Google key). Waiting on the main track: F218–F220, F227, F228, F234, F235, F258–F260, F264, F268, F269.
- Notes: the container reaches GitHub but not Google's, the OSMF's or most OGC servers, so the terms were read through search excerpts (owner question 24) and recorded capabilities come from the OpenLayers and OWSLib test suites. Fixed during development: concurrent Google 401s created one session per tile (now one renewal per refused token, unit test).

## Framework adapters track (fifth session, M14)

Branch `claude/m14-framework-adapters-y3ky8k`; status, stubs and blockers in `docs/parallel-tracks.md`.

- **2026-10-22:** `@vibeglobe/vue`: the `VibeGlobe` component (typed props, camera props that move the running engine, `ready`, `load`, `camera-change`, `globe-click` and `error` events, `placeholder` and default slots; the engine starts in `onMounted`) and the `useGlobe`, `useCamera` (one reactive object updated in place), `useLoading` and `useViewMode` (stub) composables. `@vibeglobe/web-component`: `defineVibeGlobe(tagName)`, the `<vibe-globe>` element (attributes and reflected properties, `CustomEvent`s, shadow DOM, kept running when moved within one task) and its browser build `dist/browser/vibe-globe.js` for pages without a bundler. Examples: `apps/adapter-examples` (Vite + Vue 3, React and Vue hosts, plain HTML) and `apps/nuxt-example` (Nuxt 4.5 with SSR; 4.6 needs Node 22.22.3).
- Passing: F473, F477–F484, F486, F487. Waiting for engine features: F474–F476, F485, F488, F490, F555. Leak checks: 100 cycles of each adapter on both backends leave GPU objects, DOM nodes and listeners flat and the heap within 2 KB.
- About 2.5 hours of agent time. Remaining in M14 for this track: 7 entries, all waiting on M5–M8, M10 and M12 engine features.

## Atmosphere track (eighth session, `packages/renderer/src/atmosphere/`)

- 2026-10-22, branch `claude/blissful-carson-kpbqia`: M11 entries F390–F396. F390 passes (survey `docs/research/atmosphere.md`, ADR 0040). Sky, limb glow, haze and sun lighting are built as `Atmosphere` (single scattering ray-marched per pixel with analytic light paths, one model for sky and haze, dithering, morph blending, fog-aware `ecefVisibility`, Meeus sun position within 0.02°), unit-tested and verified on both backends on the harness page (`e2e/atmosphere.spec.ts`, 13 checks).
- F391–F396 stay failing until the main session wires the atmosphere into the engine (`docs/parallel-tracks.md`, "Atmosphere hook"); F393 also needs the M5 morph, F394 and F396's terrain shading M4's terrain. Hardening steps: `docs/hardening-backlog.md`.

## Session log (newest first)

### UI and GIS utilities track (third session) — 2026-10-21 (M12)

Branch `claude/m12-ui-gis-utilities-yd90i2`, SimoneRecchia/VibeGlobe#7. New package `@vibeglobe/gis` (coordinate formats and parsing, CRS transforms through proj4js, geodesic measurement on core's geodesics, view-state serialization); `@vibeglobe/ui` gained the control API, six controls, theming, English and Italian, keyboard access and contrast. Browser tests mount the ui package on the playground through the Vite dev server (`e2e/support/ui-layer.ts`).

Passing: F404, F405, F418, F428–F433, F435 (F430's baselines recorded by the Visual baselines workflow and compared in CI run 39687581609, all Chromium shards green). Pending the reference tablet: F419, F420, F427. Waiting for engine features: F406–F417, F421–F426, F434, F436, F437 (`docs/parallel-tracks.md`).

Notes for the next session of this track:

- Control animations run on the engine clock (`Globe.timeMs`) through `frame` events: the container's software GPU draws about 4 frames per second, and wall-clock tweens jumped there.
- Pointer input on `.vg-ui` must not cancel a running tween (fixed: chained zoom presses lost part of a level).
- Local Chromium (141) differs from the baselines' (156), so screenshot comparisons are advisory locally and binding in CI.

### Session 4 — 2026-10-20/21 (milestone 2)

Done so far: F042–F063, F066–F070, F076, F077 (globe core: geodesics, projections, camera, quadtree surface, renderer on three.js with WebGPU and WebGL2, precision and depth, device-loss recovery, multiple instances); the visual regression suite and its baseline workflow; F064 (ADR 0018): per-frame code passes doubles only through typed arrays and object fields, avoids the builtins V8's mid tier calls with boxed arguments, keeps tile keys in `IntegerKeyMap`, and switches off three.js's unused lighting. Engine code allocates nothing per frame in Node and in Chromium; three.js still allocates about 5.6 KB per frame, with GC pauses of at most about 3 ms on CI's software GPU.

M2 milestone review (fresh context) found 25 issues; all are fixed or recorded (KB-012 to KB-026, ADR updates to 0004, 0005, 0009, 0010, 0012, 0018): blank globe at low altitude (exact horizon test), resize blank frame, `jumpTo` before `ready`, eye height at steep tilt, `ready` on early destroy, coordinate validation, anchor solver fallback, forced-WebGPU fallback, controls after recovery, WebGL2 vertex-array leak, recovery limits, real resource counters, 24-bit scene depth and the missing fragment depth path, single-rounded eye offsets, start-up self-test and pipeline warm-up, per-event camera math in the controls (now once per frame), circular F048 test, weak F060 test, missing property tests, ADR 0012 probes (`npm run bench:probes`), and a Firefox/WebKit CI job.

Second M2 review (fresh context) found 11 issues; all are fixed: KB-027 to KB-032 (tilt-only range jumps, zoom allocation, invalid navigation input, touch-action, canvas replacement and the cursor readout), the static failure message, ADR 0009's 0.01 px anchor accuracy, the three-lane depth-range scenario, jitter checks along the whole acceptance zoom, the tile-draw benchmarks (`drag-200/400/800-<backend>`, `GlobeOptions.minSurfaceLevel`), cold-start p90, the 100-cycle mount/unmount leak suite (`e2e/globe-leaks.spec.ts`), and ADR 0004 and 0005's GPU readback probes (`runGpuProbes`, `e2e/globe-gpu-probes.spec.ts`: 0.0004 px, canary in order, depth within 2.3e-7·d). GPU frame time is measured with timestamp queries where the browser offers them (`gpuTiming`). Also fixed: KB-033 (the anchor solver stayed interpreted under coverage, failing F064 in CI). F071–F074 passed in CI against the recorded baselines. Firefox and WebKit run in CI as a record until F504 (ADR 0012, open question 19).

Third M2 review (fresh context) found 11 issues; all are fixed: KB-034 to KB-038 (a view set before the container has a size, `ready` never settling after a start-up failure, the reused camera-change payload, invalid handlers), `Globe.captureFrame()` so tests read the engine's frame instead of a page screenshot (new baselines), start-up assertions of the test environment (SwiftShader, pinned Chromium in CI), the engine clock (`Globe.timeMs`, `manualClockStepMs`), the eye-offset micro-benchmark (`npm run bench:micro`, 0.108 ms median for 5,000 draws on an idle container), the heading test, F078's z-fighting check with parallel quads, and the order in which a recovered canvas is shown.

Fourth M2 review (fresh context) found 8 issues; all are fixed: KB-039 (EngineClock mixed small integers and doubles in one field, boxing every frame in CI), KB-040 (a frame the renderer skipped still counted and emitted), KB-041 to KB-043 (debug meshes added before start, polar tiles split into slivers: ADR 0006's cap rule now splits in latitude only), KB-044 (a device loss during recovery), KB-045 (destroyed globes kept their renderer through the loss callback and the frame hook), F078's draw order and a self-test that the z-fighting check detects z-fighting, and KB-035's assertion on the original canvas. The leak suite now waits for exactly the playground's own context.

Fifth M2 review (fresh context) found 4 issues; all are fixed: KB-046 (a container that loses its size after start turns the camera back into a requested view instead of a 1 px viewport), KB-047 (the altitude before the first frame), KB-048 (the viewport is the container's content box, without padding) and KB-049 (a recovery that finds WebGPU gone reports `backend-fallback`).

Sixth M2 review (fresh context) found 4 issues; all are fixed: KB-050 (a collapse through small sizes keeps the range: the camera keeps its pose while the container has no size), KB-051 (`captureFrame()` reads only a frame it drew), KB-052 (one `backend-fallback` when a recovery's self-test fails) and KB-053 (a globe destroyed during its recovery keeps no renderer). F064's allocation rule named the frame callback `frame` after it became `onFrame` (test fixed, docs/test-changes.md).

Seventh M2 review (fresh context) found 3 issues; all are fixed: KB-054 (a stopped loss watch keeps weak references, so the context count after destroy is real again), KB-055 (a canvas the host passes in fills its container) and KB-056 (a position-only jump while the container has no size keeps the range).

M3 groundwork, not yet used by the engine: `packages/core/src/tiling/` (Web Mercator and geographic tiling schemes, packed tile keys with the root id; F080's tests).

Eighth M2 review found 2 issues (KB-057, a real device loss reported twice; KB-058, the manual clock on frames not drawn); ninth found 3 (KB-059, a host canvas reused on WebGL2 after destroy, medium; KB-060 and KB-061, low). KB-062 (KB-057's fix kept the renderer reachable) was caught by the leak suite. From 2026-10-21 reviews close by ADR 0021: findings are classified high, medium or low; a review without high or medium findings is clean; after the first complete review, reviews are incremental on the last round's fixes, at most three, then one final complete review.

Incremental reviews (ADR 0021): the first found KB-063 (medium: a host canvas that drew with WebGPU could not be given to a WebGL2 globe); the second was clean, with one low finding fixed (KB-064). M2's reviews are closed.

Process from M3 (owner, 2026-10-21; ADR 0022, extends ADR 0021): one complete review per milestone plus one pass on its fixes only; the Chromium end-to-end suite runs in four CI shards, with the machine-wide measurements and rendering probes in their own isolated job; during feature work only the affected end-to-end specs run locally, the full suite at milestone end and nightly; subagents keep to separate packages or files. The repository was public on 2026-10-21; a scan of the whole git history found no secret; `LICENSE.md` (PolyForm Noncommercial 1.0.0) reaches `main` with the M2 merge.

Also decided: texture and geometry compression (ADR 0020, `docs/research/compression.md`), ahead of M3 (F079 is marked when M3 starts).

Notes for the next session:

- Per-frame code keeps rarely taken paths in functions of their own (ADR 0018, KB-033): V8 tiers a function up only after executing about as much bytecode as it holds.
- The browser allocation test (F064) was unstable at the previous commit (7–22.5 bytes per frame for unchanged code): V8 counts some three.js strings and buffers against the frame callback. The test now gives that function's large samples to the library (ADR 0018 update). Diagnose such cases with `--js-flags=--no-turbo-inlining --no-maglev-inlining` (exact attribution) and a second playground served from a worktree (`vite --config` with `resolve.alias` for `@vibeglobe/*`).
- The Chromium allocation test needs a 120 s warm-up: functions called once per frame reach V8's optimizing tier only after one to two minutes at 30 frames per second.
- The Vite dev server's watcher misses files rewritten by `git stash` and some scripted edits; check `ps aux | grep vite` (the pid file can be stale), kill the server and run `./init.sh` when served code looks stale.

### Session 3 — 2026-10-20 (owner decisions)

Done:

- Replaced `PLAN.md` with the owner's new version. Its diff against the old one contains only the owner's changes, and git history shows the old one was only ever changed by the owner's upload, so no agent clarification needed carrying over.
- Recorded the answers to open questions 1–12 in ADR 0015 and dated notes in ADRs 0002, 0003, 0008, 0009, 0010, 0011 and 0012; updated `docs/plan/`, four surveys, `CLAUDE.md`, the open-questions and follow-up lists.
- Renamed VibeGlobeEngine to VibeGlobe and `VGE_` to `VIBEGLOBE_` everywhere except git history (the repository had already been renamed on GitHub; the remote now points to it).
- License: `LICENSE.md` (official PolyForm Noncommercial 1.0.0 text, verified byte for byte, with the owner's required notice), the SPDX identifier in every `package.json` enforced by `npm run check` (regression test first), README licensing section, `CLA.md` (pending legal review), `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), issue and pull request templates. No third-party package ships yet; ADR 0015 explains why every allowlisted license fits.
- CI: one fast job with every non-browser check on every push and fork pull request; end-to-end and benchmarks on `main`, nightly and manual runs; no duplicate push and pull-request runs.
- Feature list: new status `superseded` (ADR 0016) for F038, F149, F342, F347, F489, F521, F534, F536 and F539, recorded in `docs/feature-changes.md` and checked by `npm run check:features`; new entries F542–F561 at their priority positions.

Verified: `npm run verify`; `npm test` (117 tests); `npm run test:e2e` (5 tests); `./init.sh` from a fresh clone; the license check fails when a package loses its license field; `check:features` fails on an unrecorded supersession; the license text matches the PolyForm Project's 1.0.0 release.

Features now passing: F542, F543, F544. Superseded: the nine entries above.

Notes for the next session:

- F545 cannot pass before a merge into `main` and a nightly run (see Current state).
- Live Google tests will be a separate `npm run test:live` command, never skipped tests inside a suite (ADR 0015, decision 5).

### Session 2 — 2026-10-20 (milestone 1)

Done:

- Research surveys for every M1 core area in `docs/research/` (precision, depth, levels of detail, scheduling and caching, globe-to-flat, camera control, GPU and renderer, workers, testing and benchmarks), written by parallel subagents from the projects' code at pinned commits, with linked issue-tracker failure modes, and the decisions in ADRs 0004–0012. `docs/plan/architecture.md` and `quality.md` now follow those ADRs.
- Monorepo with every package of the architecture (same layout, a `CLAUDE.md` each), Prettier, ESLint (no `any`, TSDoc on public APIs, length limits, no focused/skipped tests, a local no-commented-out-code rule), knip, repository checks (`npm run check`: layout, dependency rules, hot-path headers, build info inside `dist/`), feature-list integrity and test guards, SSR import test, coverage minima, bundle-size budgets, tree-shaking check, consumer check, license audit and generated notices, benchmark harness, TypeDoc site, Claude Code PostToolUse hook, GitHub Actions CI. `npm run verify` runs every non-browser check.
- `FrameStats` (core) and a lazily loaded debug overlay (ui) driven by a playground frame loop; e2e tests for the playground and the docs site.
- Bugs found and fixed regression-first: KB-001 (the commented-out-code rule never reported), KB-002 (a deleted `dist/` was not rebuilt), KB-003 (the feature-list guard crashed on a base without the list, seen on the first pull request), KB-004 (unused exports of script modules went unreported), KB-005 (focused or skipped Playwright tests passed lint), KB-006 (the playground frame loop leaked performance entries).
- Six fresh-context milestone reviews; every gap they found is addressed. The sixth, on the merged `main`, found no correctness or requirement gaps; the fifth found only a stale test name in the KB-007 row, then fixed. The fourth found only small ones ( two id labels, tagged-template test tables, a skip destructured in a test body, `bundleExternal` as a loosening (KB-009), and app tests not collected by Vitest). The second and third passes added: lint and Playwright config holes (`e2e/*.test.ts`, nested `skipIf`, context-provided `skip`: KB-008), the test guard's blind spot for chained test forms (KB-007), late-frame counting and gates defined once in ADR 0014 (budget tightened to 17.2 ms), `npm run verify` now also builds the playground and the docs like CI, and feature ids in ADRs 0005–0013 and six surveys corrected from the draft numbering to the final one. The first pass found: the KB-005 and KB-006 bugs; the benchmark harness now follows ADR 0012 (warm-up, 5 fresh-page runs, 2 s discarded, median of per-run p95, p50/p95/p99/max and frames over 16.7/33.3 ms, schema-versioned results with device, GPU, pixel ratio and resolution under `benchmarks/results/<device>/`, a recorded CI job); Playwright retries once on CI with `failOnFlakyTests`; ADR conventions require before-and-after measurements; stale docs fixed; ADR 0013 reconciles the conflicting ADR points (infinite far plane with CPU culling, caps on the flat map, per-tile terrain buffers, public renderer events, tile root ids, ADR 0012 probes moved to M2, the 18 ms frame-time budget).

Verified: every check was broken on purpose in a local scratch branch and failed as required (results in the commit history of this session); CI run 3 failed on a deliberate type error; the revert's own run failed on `format:check` (a table in `docs/plan/quality.md` committed unformatted in the same push), and CI was green again from the next push; `./init.sh` from a fresh clone exits 0; every command listed in the `CLAUDE.md` files works; a jscpd scan found no code shared between this repository and CesiumJS, MapLibre GL JS, deck.gl, iTowns, OpenGlobus, 3DTilesRendererJS, three.js and OpenLayers (1,844 duplicates found inside those projects, none across).

Features now passing: all of M1, F001–F041. F002, F027 and F041 were marked last: after the merge into `main` (SimoneRecchia/VibeGlobe#1), green CI run 20 on `main`, `./init.sh` from a fresh clone of the merged tree, and a final fresh-context review reporting no gaps.

Decisions to note: three.js is the rendering base, pinned to exactly `three@0.186.1` (ADR 0010; r187 required before M4). The initial-JavaScript budget needs the owner's review in M2 (open question 12).

Notes for the next session:

- The owner questions in `docs/open-questions.md` (8–11) came out of the surveys; the defaults used meanwhile are listed there.
- ADR 0011 adds a `@vibeglobe/worker` package in M3; add it to `LIBRARY_PACKAGES` in `scripts/checks/structure.ts` then.
- ADR 0012 lists engine test hooks (frame read-back, injectable clock, ready/idle events) to build in M2–M3.

### Session 1 — 2026-10-20

Done:

- Read `PLAN.md`; wrote the technical plan in `docs/plan/` (architecture, API sketches, milestone task breakdown, targets, budgets and testing strategy).
- Turned every requirement into `feature_list.json` (541 entries across the 15 milestones, all `failing`). Drafted in parallel per milestone group (536 entries), merged in milestone order, then checked by two fresh-context reviewers and fixed before the first commit:
  - Coverage review added 11 entries (private repository, test-weakening guard, function and module size limits, deviations recorded in ADRs, compression / data-pipeline / data-layer surveys, layer plug-ins, cache-store and network-policy plug-ins, terrain and vector tiles in packages) and strengthened weak ones (no open known bug in every acceptance entry, both offline setups in the switch matrix, touch pan, explicit cancellation, glTF conformance).
  - Fidelity review fixed entries that required capabilities from later milestones (moved, or limited to what exists then), contradictions (three.js no longer mandatory; OpenStreetMap profile limits only what its terms forbid; phones best effort; owner approval before publishing) and unprovable steps (numeric thresholds).
  - Removed as duplicates or overreach: a second custom-elevation-encoding entry, a second tree-shaking entry, the in-browser package builder, the optional fresher Sentinel-2 mosaic and OpenStreetMap raster tiles (the last three moved to `docs/follow-ups.md`).
- Created `init.sh`, `npm run status` (`scripts/status.ts`), `CLAUDE.md`, `README.md`, ADRs 0001–0003, the research-survey index, `docs/open-questions.md` and `docs/follow-ups.md`.
- Minimal monorepo so `init.sh` works end to end: TypeScript 6.0.3 project references, Vite 8, Vitest 5, Playwright 1.64 (drives the container's preinstalled Chromium through `VIBEGLOBE_CHROMIUM_PATH`).

Verified: `./init.sh` from scratch (install, build, playground up, 2 unit tests and 1 e2e smoke test green, status printed); re-run reuses the running playground; `kill $(cat .playground.pid)` stops it; `npm run status` rejects invalid statuses and duplicate ids.

Notes for the next session:

- The playground smoke test caught a favicon 404 (fixed with an inline empty icon): keep the "no console errors" assertion.
- Owner questions are in `docs/open-questions.md` (registry scope, reference devices, dataset hosting, Sentinel-2 egress, Google API key, CI capacity, license).
