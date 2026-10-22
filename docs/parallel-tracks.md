# Parallel tracks

Since 2026-10-21 several Claude Code sessions work on the repository at the same time (owner's decision). Each session edits only what it owns; anything else it needs from the other track arrives as a pull request that the owning session reviews.

**2026-10-22: every parallel track is merged into `main` and its session is closed** (owner): the data pipeline (SimoneRecchia/VibeGlobe#6), UI and GIS utilities (#7), source adapters (#11), data layers (#12), framework adapters (#13) and offline engine (#14). The main session is now the only session and may edit every package. The ownership rules below are kept as history. The waiting lists of each track below are the main session's to-do for the milestone they belong to (M7, M8, M9, M10, M12, M14): in that milestone's review the track's code is reviewed with the rest, the engine features it waits for are wired, its stubs are replaced, and every open row of "Hook requests" is answered (done, or the reason it is not).

| Track                                               | Session                                                                               | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine (M3–M8, M10, M11, M13–M15; M12's acceptance) | Main session, branch `claude/happy-galileo-b07j98`; the only session since 2026-10-22 | Every package and app except those of the other tracks below; in M7, layer composition, reprojection and color harmonization; in M8, memory reuse and prefetch in the loader (F281–F285), motion-aware detail (F288), bandwidth estimation and adaptation (F300–F303) and the acceptance (F329); M12's and M14's acceptance (F438, F490); every `feature_list.json` entry not listed below                                                                                                                                                                |
| Data pipeline and offline package builder           | Merged (SimoneRecchia/VibeGlobe#6); session closed 2026-10-22                         | `packages/tools` (the command-line tools); M9, data pipeline and default datasets (F330–F347, F551–F554); the offline package builder CLI (F304, F305, F307); the `status` of those entries in `feature_list.json` and their records in `docs/`                                                                                                                                                                                                                                                                                                           |
| UI and GIS utilities (M12)                          | Merged (SimoneRecchia/VibeGlobe#7); session closed 2026-10-22                         | `packages/ui` (its existing debug overlay included) and a GIS utilities package of its own: coordinate parsing and formatting, CRS transforms, geodesic measurement, view-state serialization; M12 entries F404–F437 and their records in `docs/`                                                                                                                                                                                                                                                                                                         |
| Source adapters of M7                               | Merged (SimoneRecchia/VibeGlobe#11); session closed 2026-10-22                        | In `packages/sources`, every M7 source adapter except the XYZ imagery adapter (`xyz-imagery.ts`) and `fetchTransport`, with the Google and OpenStreetMap provider profiles; those entries' `status` in `feature_list.json` and their records in `docs/`                                                                                                                                                                                                                                                                                                   |
| Framework adapters (M14)                            | Merged (SimoneRecchia/VibeGlobe#13); session closed 2026-10-22                        | `packages/vue`, `packages/web-component` and a minimal Nuxt example app (`apps/nuxt-example`), built on the engine's public API only; M14 entries F473–F488 and F555, their `status` in `feature_list.json` and their records in `docs/`                                                                                                                                                                                                                                                                                                                  |
| Offline engine (M8)                                 | Merged (SimoneRecchia/VibeGlobe#14); session closed 2026-10-22                        | `packages/offline`: persistent cache and storage backends, quotas and eviction, cache policy and revalidation, offline package management, versions and integrity checks, network modes (online only, offline only, hybrid), connectivity detection, the loading switches and their per-layer overrides, provider-rule enforcement for caching and packaging, flight preloading once `flyTo` exists; M8 entries F270–F280, F286, F287, F289–F299, F306, F308–F319, F326–F328 and F550, their `status` in `feature_list.json` and their records in `docs/` |
| Data layers (M10, renderer-independent parts)       | Merged (SimoneRecchia/VibeGlobe#12); session closed 2026-10-22                        | In `packages/layers`: the layer stack and plug-in interface, feature storage and live updates, data-driven and zoom-dependent styling, clustering, label placement and collision, the picking id scheme and feature interaction, the vector data layer on a typed stub of the M7 format adapters; the M10 surveys (F348–F350) and ADR 0029; the `status` of M10 entries and their records in `docs/`. Drawing, draping, ground clamping, terrain picking and glTF models stay with the main session                                                       |

Rules:

- The main session does not edit `packages/tools`. When it reaches M8 and M9 it uses and reviews the second session's pull request instead of rebuilding that work; the engine side of offline packages (reading, installing and serving packages, network modes; M8) stays with the main session.
- The main session does not edit `packages/ui` or the GIS utilities package. When it reaches M12 it reviews and integrates the third session's pull request instead of rebuilding it, and runs the M12 acceptance (F438).
- The second and third sessions do not edit other packages. A change it needs elsewhere (a core API, a shared script, CI) is asked of the main session or proposed in its pull request for review.
- The main session does not edit the fourth session's source adapters. When it reaches M7 it reviews and integrates that session's pull request instead of rebuilding it; layer composition, reprojection and color harmonization stay with the main session, and so do the source contract below, the XYZ imagery adapter, `fetchTransport` and the terrain adapters of M4 (`heightmapTerrain`, `quantizedMeshTerrain`).
- The fifth and sixth sessions do not edit `packages/core`, `packages/renderer` or any package but their own. The fifth uses only the engine's public API. The sixth plugs into the frozen source contract and transport below and reads packages through the fourth session's PMTiles and MBTiles adapters (F232, F233); flight preloading (F286, F287) waits for `flyTo` (F195, M6). When either needs a hook in another package, it adds a row to "Hook requests" below; the main session checks that table at the end of each feature group, adds small hooks promptly and records each answer there. When the main session reaches M8 and M14 it reviews and integrates these sessions' pull requests instead of rebuilding their work, and runs the milestones' acceptance (F329, F490).
- ADR numbers: a number is taken once its ADR is on `main`. A track whose branch uses a number that `main` has since given to another ADR renumbers its own before merging.
- `feature_list.json` changes only in the `status` of each session's own entries, so the branches merge without conflicts; shared files (`progress.md`, `docs/open-questions.md`, `docs/follow-ups.md`, `docs/known-bugs.md`) take separate sections or rows per track.

## Source contract (frozen 2026-10-22)

The fourth session builds its adapters against this contract. It is frozen. The main session announces any later change
in this section, dated, before the change lands on `main`.

- **`TileSource` and `ImagerySource`** (`packages/core/src/imagery/imagery-source.ts`):
  - the tiling scheme, levels, coverage, request limits and timeouts;
  - `request(coord, out)`, which writes a URL and host index, or answers `'noData'` (the tile never exists) or
    `'unknown'` (availability is not known yet and comes with an ancestor's metadata, F128);
  - for imagery, the decoder description.
- **Scheduler types** (`packages/core/src/scheduler/types.ts`): `TileRequest`, `TimeoutsMs`, `TransportResult`,
  `TileTransport`, `AbortHandle` and `DecodedTile`. A transport reports `ok` bytes, an HTTP status with its
  `Retry-After`, or a network error, timeout or abort. It never throws.
- **Tiling schemes** (`packages/core/src/tiling/`): `TilingScheme`, `TileCoord` and the Web Mercator and geographic
  schemes.
- **In `@vibeglobe/sources`:** `fetchTransport` and `retryAfterMs` (a source may bring its own transport with the same
  contract), and `xyzImagery` as the reference adapter.

The `'unknown'` answer arrives on `main` with the M4 merge, from branch `claude/happy-galileo-b07j98`. The rest of the
contract is on `main` already. Terrain sources (`TerrainSource`, `packages/core/src/terrain/terrain-source.ts`, with
their `tileMetadata` hook) belong to M4 and are not part of the fourth session's work.

## Hook requests

Open rows are the main session's to-do (2026-10-22): each is answered in the milestone that wires it (M7: sources and credits; M8: offline hooks (1)–(5); M10: layer rendering, picking and pointer routing).

Hooks a track needs in a package it does not own. The requesting session adds a row; the main session answers in the
last column (landed on `main`, or why not) and announces any change to the source contract above.

| Date       | Track               | Hook needed (package, API, why)                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Answer |
| ---------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 2026-10-22 | Offline engine (M8) | (1) `packages/core`: honour per-source loading decisions in the imagery loader, through a `NetworkPolicy`-like hook (`keepInMemory`, `prefetch`) that `@vibeglobe/offline` resolves from the mode, the switches and the provider profile. Without it the memory-reuse and prefetch switches are stored and resolved but core ignores them (F271, F290, F314; shared with F281–F285).                                                                                                                  |        |
| 2026-10-22 | Offline engine (M8) | (2) `packages/core`: `Globe.reloadSource(sourceId)` (or an invalidation event) that drops a source's GPU and RAM tiles and its no-data marks, so a new package version or a switch from offline-only to hybrid reaches tiles already in memory without recreating the globe (F279, F312 seamless; today the harness recreates the globe).                                                                                                                                                             |        |
| 2026-10-22 | Offline engine (M8) | (3) `packages/core` (optional): a transport result `offline` that parks a tile until a resume signal, replacing the offline track's hold-and-abort workaround (a miss while an endpoint is unreachable is held 500 ms, then answered `aborted`), and that counts as settled for `Globe.ready`: today a start with the network down and no data for the pinned levels keeps `ready` pending until connectivity returns.                                                                                |        |
| 2026-10-22 | Offline engine (M8) | (4) `apps/playground`: wrap its fixture sources with `createOffline().source()`, add `?network=online\|offline\|hybrid`, and show the per-tier counters (`Offline.stats()`) in the debug overlay (`?debug=1`). The offline specs use `e2e/support/offline.html` on the playground's dev server meanwhile (F272, F291–F293 name the playground).                                                                                                                                                       |        |
| 2026-10-22 | Offline engine (M8) | (5) `playwright.config.ts`: add `offline-browsers.spec.ts` (WebGL-free storage checks) to `CROSS_BROWSER_SPECS`, so CI's Firefox and WebKit job runs them (F273, F276 ask for all three browsers; the container cannot download Firefox or WebKit). Proposed in the offline track's pull request together with Firefox's `dom.storageManager.prompt.testing` prefs, which answer `persist()`'s permission prompt headless; CI runs 39822457570 and 39831959616 pass both specs in Firefox and WebKit. |        |
| 2026-10-22 | Source adapters     | `packages/worker`: register `VECTOR_TASKS` from `@vibeglobe/sources/vector` in the worker program's task table, so the GeoJSON, KML, GPX and MVT parsers run in the engine's pool (F236–F239; until then a browser test runs them in a module worker of its own)                                                                                                                                                                                                                                      |        |
| 2026-10-22 | Source adapters     | `packages/core`: read `attribution` and `profile` from sources that carry them (`DescribedImagerySource`), for the credits list and profile enforcement (F254, F255, F258, F259, F264)                                                                                                                                                                                                                                                                                                                |        |
| 2026-10-22 | Source adapters     | `packages/core` transport contract: carry the response's `Cache-Control` and `Expires` in an `ok` result, so the RAM tier can reuse Google tiles only while their headers allow it (F260)                                                                                                                                                                                                                                                                                                             |        |
| 2026-10-22 | Source adapters     | `packages/core` imagery decoder description: an optional crop rectangle, so WMS gutters are cropped in the decode task instead of re-encoded in the adapter's transport (F231 works meanwhile)                                                                                                                                                                                                                                                                                                        |        |
| 2026-10-22 | Data layers (M10)   | `renderer`: implement `LayerRenderTarget` (`packages/layers/src/render-target.ts`): batches per primitive kind with the listed attributes (float64 positions made camera-relative per ADR 0004), text and icon channels, line and polygon geometry, per-batch uniforms, draw order, visibility and `growBatch`; partial uploads of the ranges `writeRange` names. Needed for every drawing entry (F351–F360, F362, F366–F370, F372–F378, F384, F385, F388)                                            |        |
| 2026-10-22 | Data layers (M10)   | `renderer`: an id-buffer pass that draws each batch's `pickId` attribute (RGBA8, depth-tested, cleared to 0) and an asynchronous read of a small region around a screen point, exposed as `pick(point): Promise<number>` for `InteractionController` (`packages/layers/src/interaction.ts`); the id format is in `packages/layers/src/picking.ts` (F379–F382, F384)                                                                                                                                   |        |
| 2026-10-22 | Data layers (M10)   | `renderer`: SDF glyph rendering of the `text` channel with a glyph atlas built in workers, a `TextMeasurer` with the real glyph metrics for collision boxes, an icon atlas for the `icon` channel with an `addImage(name, image)` API (F352, F357–F360)                                                                                                                                                                                                                                               |        |
| 2026-10-22 | Data layers (M10)   | `core`: `Globe.layers` as a `LayerStack` on the renderer's target, `stack.frame({ nowMs: timeMs, zoom, projector })` once per frame before drawing, and a `ScreenProjector` that follows the morph and hides points behind the horizon (labels and clusters use it)                                                                                                                                                                                                                                   |        |
| 2026-10-22 | Data layers (M10)   | `core` and `controls`: pointer events offered to `InteractionController` before the camera gestures, so a press on a draggable feature (`pointerDown` answers true) does not pan the map; `screenToGeo` with terrain height for event positions (F380, F382, F383)                                                                                                                                                                                                                                    |        |
| 2026-10-22 | Data layers (M10)   | `worker`: tasks in the shared pool for `ClusterEngine` (supercluster index and per-zoom diffs, `packages/layers/src/cluster.ts`) and `VectorFormatAdapter.parse` (F371, F373, F375)                                                                                                                                                                                                                                                                                                                   |        |

## Status

| Track                                     | Status (latest first)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data pipeline and offline package builder | 2026-10-22, branch `claude/tools-offline-builder-uvuuxe`, pull request SimoneRecchia/VibeGlobe#6. Passing: F330–F335, F338, F340, F343–F346, F552, F553, F307. The other entries of this track wait only on engine capabilities of the main track (table below); the pipeline side of each is built and tested. Detailed imagery: ESA WorldCover 2021 (owner decision, ADR 0026), verified on real data over Mont Blanc and the Gulf of Naples. Owner question 23 (license pages from an unrestricted network). |

### Entries of this track waiting on the main track

Each entry below has every pipeline step built and verified on this branch; the step that remains loads the output through an engine capability that the main track has not built yet. The entry passes once that capability exists; no change to `packages/tools` is expected.

| Entry | Remaining step                                                                                  | Waits on (main track)            | Verified meanwhile                                                                                                                                        |
| ----- | ----------------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F336  | Load the package through the PMTiles or MBTiles adapter; offline package integrity check        | F232, F233 (M7), F309 (M8)       | Static folder through the XYZ adapter with no empty pixel; package tiles byte-identical to the static folder (own reader and the Python `pmtiles` reader) |
| F337  | The playground shows the recorded attribution                                                   | F254, F255 (M7)                  | Every output's metadata carries license, attribution, sources, data year, configuration and pipeline versions                                             |
| F339  | Relief through the terrain adapter, no cracks on both backends                                  | F129 (M4)                        | Real Copernicus DEM around Mont Blanc: 1,000 points within 2.2 mm of GDAL's reading of the source (pinned Docker image); Copernicus notice in metadata    |
| F341  | The engine's MVT adapter conformance suite                                                      | F239 (M7)                        | Extract downloaded only from its provider; roads, places and buildings (height, levels) decoded by an independent decoder (`mapbox-vector-tile`)          |
| F304  | Navigate the package in the playground in offline-only mode                                     | F232 (M7), F292 (M8)             | Exactly the tiles of the area and zoom range in a valid PMTiles archive                                                                                   |
| F305  | Navigate the MBTiles package in offline-only mode                                               | F233 (M7), F292 (M8)             | Every tile intersecting the polygon and none outside it                                                                                                   |
| F551  | Load the sample outputs as source chains across the high-detail boundary; MVT conformance suite | F247, F248, F239 (M7), F129 (M4) | Both configurations cover every dataset, run on their sample areas, stop at their zooms, estimate without downloading; a new region needs only a new file |
| F554  | Milestone acceptance                                                                            | the entries above                | —                                                                                                                                                         |

## UI and GIS utilities track: status

The third session's packages are `@vibeglobe/ui` (controls, theming, translations) and `@vibeglobe/gis` (coordinate formats, CRS transforms through proj4js, geodesic measurement on core's geodesics, view-state serialization). Its end-to-end tests (`e2e/ui-*.spec.ts`) mount the ui package on the playground's globe through the Vite dev server (`e2e/support/ui-layer.ts`), so the playground itself is unchanged.

### Stubs for engine features that do not exist yet

| Stub                                                              | Where                                 | Replaced by                                       |
| ----------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------- |
| `ElevationProvider`: terrain height under the pointer             | `packages/ui/src/controls/readout.ts` | Picking with elevation on terrain (F383, M4, M10) |
| `Geocoder`: the pluggable search provider interface               | `packages/ui/src/controls/search.ts`  | The engine's geocoder interface (F208, M6)        |
| `GoTo`: moving to a search result is a `jumpTo`                   | `packages/ui/src/controls/search.ts`  | `flyTo` (F195, M6)                                |
| `ViewMode` (`auto`, `2d`, `3d`) and the chosen tilt in view state | `packages/gis/src/view-state.ts`      | View modes and chosen tilt (F161, F163, F215, M5) |
| Zoom limits 0–22, plus limits learned from steps the engine stops | `packages/ui/src/controls/zoom.ts`    | Zoom constraints (F209, M6)                       |

### Entries waiting for engine features

| Entry      | Waits for                                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| F406       | Terrain elevation under the pointer (F383; terrain, M4)                                                         |
| F407       | Point primitives (F351) and picking (F380, F383)                                                                |
| F408, F409 | Polylines and polygons draped on terrain (F364, F365) and picking (F383)                                        |
| F410       | F407–F409 (the drawn shapes it edits)                                                                           |
| F411       | F407–F410 (measurement runs on the drawing tools); the measurement functions themselves are in `@vibeglobe/gis` |
| F412       | The 2D and tilted 3D phases (F152, F162)                                                                        |
| F413       | Point primitives for the marker and accuracy circle (F351) and `flyTo` with the view-mode rules (F195, F201)    |
| F414       | View modes and the chosen tilt (F161, F163, F215); the serializer is built and tested with the `ViewMode` stub  |
| F415       | `flyTo` (F195) to open a bookmark, and F414                                                                     |
| F416       | Live attribution and logos (F254, F255, F259) and rendering a frame larger than the canvas (no engine API yet)  |
| F417       | The 2D and tilted 3D phases (F152, F162) for the footprint                                                      |
| F421       | View modes and the zoom-driven curves (F161–F163, F548)                                                         |
| F422       | The chosen tilt and its temporary clamp (F215, F210)                                                            |
| F423       | `flyTo` with the view-mode rules and reduced motion (F195, F201, F214)                                          |
| F424       | The engine's live list of credits (F254)                                                                        |
| F425       | Runtime layer order and visibility (F243–F245)                                                                  |
| F426       | The geocoder interface (F208) and `flyTo` (F195); the search box works now with the stubs above                 |
| F434       | The ARIA states of the 2D/3D/Auto toggle (F421) and the layer switcher (F425), which the audit must cover       |
| F436       | Flights that become quick fades with reduced motion (F214, F195)                                                |
| F437       | The attribution control (F424), which the layout must never cover                                               |

## Data layers track: status

The seventh session's work is in `packages/layers` (ADR 0029). Everything is tested in Node against `RecordingRenderTarget`, which records what a renderer would upload; no other package is edited. Surveys: [picking](research/picking.md), [labels](research/labels.md), [data layers](research/data-layers.md).

Built: `LayerStack` (add, remove, move above, below or to an index, show, hide; pick-slot table), the `Layer` plug-in interface, `DataLayer` for points, markers, labels, polylines, polygons and circles with MapLibre-expression styles and feature state, single-feature updates that upload only the changed rows, streamed data from async iterables, `ClusterLayer` (supercluster, animated splits and merges, cluster extent), `LabelLayer` and `LabelPlacer` (rbush collision by `symbol-sort-key` and id, 300 ms passes and fades), `InteractionController` (hover, click, selection, drag), and `GeoJsonLayer` (URL, File, text or object). Time-dependent data arrives as streams and live updates; transitions and fades run on the engine clock passed to `frame`.

### Stubs for work of other tracks

| Stub                                                                                                                  | Where                                  | Replaced by                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Vector parsing on the calling thread (`geojsonFormat`, `kmlFormat`, `gpxFormat` on the M7 parsers, merged 2026-10-22) | `packages/layers/src/vector-format.ts` | The parsers as worker-pool tasks, once the worker program registers `VECTOR_TASKS` (the source adapters track's hook request) |
| `estimatedTextMeasurer`: 0.6 em per character, 1.2 em high                                                            | `packages/layers/src/render-target.ts` | The renderer's glyph metrics (hook request above)                                                                             |
| `localClusterEngine`: supercluster on the calling thread                                                              | `packages/layers/src/cluster.ts`       | A worker-pool task (hook request above)                                                                                       |
| `RecordingRenderTarget`                                                                                               | `packages/layers/src/render-target.ts` | The renderer's `LayerRenderTarget` (hook request above)                                                                       |

### Entries of this track and what they wait for

Passing on this branch: F348, F349, F350 (the surveys).

| Entry      | Built and unit-tested here                                                                                                | Waits for                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| F351       | Point batches, `circle-*` styles, positions                                                                               | `LayerRenderTarget` in the renderer; the 2D and tilted phases (F152, F162, M5)                             |
| F352       | Marker batches, `icon-*` styles, anchors                                                                                  | The renderer's billboards and icon atlas; the phases                                                       |
| F353       | Line geometry and `line-*` styles                                                                                         | Line rendering and geodesic subdivision; the phases                                                        |
| F354       | Polygon geometry with holes and `fill-*` styles                                                                           | Triangulation in the worker pool (earcut) and polygon rendering; the phases                                |
| F355       | `fill-extrusion-height` and `-base` attributes                                                                            | Extrusion rendering; terrain (M4) for the sloped cases                                                     |
| F356       | Circle batches                                                                                                            | Geodesic outline generation with the renderer's circle primitive; the phases                               |
| F357, F358 | Label batches, `text-*` styles, the text channel                                                                          | SDF glyph rendering and atlas (hook request)                                                               |
| F359, F360 | Collision with priorities, debug collision boxes, fades (`label-layer.test.ts`)                                           | Label drawing and glyph metrics; the browser frame recordings; time-slicing measured in the browser        |
| F361       | —                                                                                                                         | glTF models: main session                                                                                  |
| F362       | `{ absoluteAltitudeMeters }` placement                                                                                    | Drawing in the three phases; terrain relief scaling on the plane (M4, M5)                                  |
| F363       | `'clamp-to-ground'` placement passed to the renderer                                                                      | Ground clamping and terrain refinement events: main session (M4)                                           |
| F364, F365 | `'drape'` placement passed to the renderer                                                                                | Draping in the terrain overlay pass: main session (M4)                                                     |
| F366       | —                                                                                                                         | The globe-to-flat morph and tilt (M5) applied to layer batches                                             |
| F367, F368 | Float64 positions; geometry with parts                                                                                    | Camera-relative layer drawing; antimeridian and pole splitting with the renderer's primitives              |
| F369, F370 | Expressions, malformed-style errors, live restyle, zoom uniforms (`style.test.ts`)                                        | Screenshots and frame recordings through the renderer                                                      |
| F371       | `GeoJsonLayer` from URL, File, text and object for GeoJSON, KML and GPX through the M7 parsers; one error event per issue | Parsing in the worker pool (`VECTOR_TASKS` registration); MVT through the vector-tile layer (M13); drawing |
| F372       | Streamed chunks shown the next frame, no rebuild (`data-layer.test.ts`)                                                   | Drawing and frame-time measurement                                                                         |
| F373       | Counts, animated split and merge, cluster extent (`cluster-layer.test.ts`)                                                | Drawing; the cluster engine in the worker pool; `fitBounds` or `flyTo` (F195, M6) for zoom on click        |
| F374       | —                                                                                                                         | Marker level of detail needs the renderer's simplified symbols and cross-fade                              |
| F375       | —                                                                                                                         | Worker-pool clustering and parsing, and the browser memory measurement                                     |
| F376, F377 | Only changed rows uploaded (`feature-store.test.ts`, `data-layer.test.ts`)                                                | The renderer's partial uploads and its instrumentation in the browser                                      |
| F378       | Allocation-free position updates                                                                                          | The renderer and the reference desktop                                                                     |
| F379–F381  | Hover, click and selection events and styles (`interaction.test.ts`)                                                      | The id-buffer pass and pointer routing (hook requests); elevation in events needs F383                     |
| F382       | Drag events, no pan while dragging (`interaction.test.ts`)                                                                | Pointer routing in core and controls; terrain for dragged clamped features (M4)                            |
| F383       | —                                                                                                                         | Terrain picking: main session (M4)                                                                         |
| F384       | Picking id scheme and nearest-pixel choice (`picking.test.ts`)                                                            | The id-buffer pass in every phase and during flights (M5, M6)                                              |
| F385       | Batches, pick slots and listeners freed over 100 cycles (`layer-stack.test.ts`)                                           | The renderer's GPU and RAM counters for layer batches                                                      |
| F386       | —                                                                                                                         | Runnable examples need drawn layers                                                                        |
| F387       | —                                                                                                                         | Fitting the camera (F195, M6)                                                                              |
| F388       | The public `Layer` interface                                                                                              | Drawing and picking of a custom layer                                                                      |
| F389       | —                                                                                                                         | The entries above                                                                                          |

## Offline engine track (sixth session): status

Branch `claude/gifted-mayer-p0kexd`. `@vibeglobe/offline` (ADR 0033, survey `docs/research/offline-and-network.md`,
guide `docs/guides/offline.md`): tier wrapper for sources (`createOffline().source()`), IndexedDB cache in a worker,
cache policy and revalidation, connectivity from health checks, network modes and loading switches, the package manager
(install, list, update, remove, integrity, resumable installs, in-browser builds), and the Docker LAN server
(`packages/offline/lan-server/`). Browser specs: `e2e/offline-*.spec.ts`, on the harness page
`e2e/support/offline.html` of the playground's dev server, because the playground's own sources do not go through the
offline package yet (hook requests above).

### Stubs

The packages load through the M7 adapters themselves (`pmtilesImagery`, `mbtilesImagery`) since the merge of the source
adapters track; F304, F305 (`e2e/offline-cli-packages.spec.ts`) and F336 (`scripts/integration/package-outputs.test.ts`)
pass with them.

| Stub                                                                                     | Where                           | Replaced by                                                                                    |
| ---------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------- |
| Provider rules (`ProviderRules`, a structural subset of the adapters' `ProviderProfile`) | `packages/offline/src/types.ts` | Nothing: an adapter's `profile` (`DescribedImagerySource`) is read as is by `offline.source()` |

### Entries waiting for engine features

| Entry                        | Waits for                                                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F271                         | Memory reuse and prefetch acting in core (F281–F285, hook request (1)); the playground's own sources wrapped (hook request (4))                                |
| F272                         | The per-tier counters in the playground's debug overlay (hook request (4)); the persistent, package and network tiers are counted                              |
| F286, F287                   | `flyTo` (F195) and motion-aware detail (F288)                                                                                                                  |
| F290                         | Memory reuse and prefetch switches acting in core (hook request (1)); per-layer scopes for layer chains (F247)                                                 |
| F292–F296, F298              | Flight scenarios (`flyTo`, F195); their zoom and pan parts are covered by the network, package and LAN specs                                                   |
| F306                         | The live credits and the attribution element (F254, F255)                                                                                                      |
| F314                         | Hook request 1 and flight scenarios (F195)                                                                                                                     |
| F315, F316                   | Flight scenarios (F195) and prefetch with flight preloading (F284, F286) in the scenario suite                                                                 |
| F326                         | The fourth session's shared conformance suite with profile-enforcement checks, the attribution element (F255) and core honouring a profile's concurrency limit |
| F328                         | The terrain and MVT adapters (F129, F239) and terrain in core (M4)                                                                                             |
| F337, F339, F341, F551, F554 | As listed for the data pipeline track above (F254/F255, F129, F239, F247/F248)                                                                                 |

## Source adapters track: status

Fourth session, branch `claude/m7-source-adapters-0gkrjg`. Adapters in `packages/sources`, shared conformance suites in `@vibeglobe/sources/conformance`, browser tests in `e2e/sources-*.spec.ts` (they mount a globe with the adapter over the playground through the Vite dev server, `e2e/support/sources.ts`; the playground is unchanged).

Shared files this track touched (for review): `tsconfig.tools.json` (includes the sources fixtures for the browser tests), `knip.json` (worker entry of the browser tests), `scripts/integration/` (a test across the tools and sources packages).

Passing: F230 (WMTS), F231 (WMS), F232 (PMTiles), F233 (MBTiles), F236 (GeoJSON), F237 (KML and KMZ), F238 (GPX), F239 (MVT), F223 (shared conformance suite: every built-in adapter, a custom package, the opt-in live run), F256 and F261 (Google terms and billing regions, ADR 0031), F257 (Google 2D tiles and sessions), F262 (Street View), F263 and F265–F267 (OpenStreetMap public-servers profile, ADR 0032); from the data pipeline track, F341 (its OpenStreetMap vector tiles pass the MVT conformance suite, `scripts/integration/osm-vector-tiles.test.ts`). Pending the owner: F549 (one live run with the restricted Google key, `npm run test:live-sources`). Survey: `docs/research/source-adapters.md`; guide: `docs/guides/sources.md`.

### What the frozen contract lacks, and the workaround

| Gap                                                                                                                         | Workaround in `@vibeglobe/sources`                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ImagerySource` has no attribution or provider profile (docs/plan/api.md `SourceMetadata`)                                  | Adapters return `DescribedImagerySource`: the contract's fields plus `attribution` and `profile` (`metadata.ts`), for the engine to read when it builds credits (F254) and enforces profiles                                                                                              |
| `request()` is synchronous and returns a URL, while archives (PMTiles, MBTiles) and session-based services need async steps | The adapter factory is async (it reads the header, metadata or session first); `request()` writes a pseudo URL `<archive>#z/x/y` that keeps the host for per-host concurrency, and the adapter's own transport (`archiveTransport`) resolves it                                           |
| The engine's worker program registers only its own tasks                                                                    | The vector parsers are a task table, `VECTOR_TASKS` in `@vibeglobe/sources/vector`; a browser test runs them in a module worker (`e2e/sources-vector.spec.ts`). The main track adds the table to the worker program (`packages/worker/src/tasks.ts`) when M10 and M13 consume vector data |
| There are no vector source or feature types in core                                                                         | The parsers return GeoJSON-shaped `VectorFeature` structures (`vector/features.ts`); MVT tiles decode to layers with extent-scaled geometry                                                                                                                                               |
| Network faults on a package downloaded whole (MBTiles) happen while opening, not per tile                                   | The tiled conformance suite takes `network: 'on-open'` for such sources and checks that opening fails with a descriptive error                                                                                                                                                            |

### Entries of this track waiting on the main track

| Entry                                        | Waits on                                                                                                                                               | Built and verified meanwhile                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| F218                                         | The main track's reprojection, source-chain and color-matching decisions and their ADR, which the survey must link (the approaches found are recorded) | `docs/research/source-adapters.md`: engines, formats, failure modes, testing, the adapters' approach (ADR 0030)             |
| F219                                         | Attaching custom adapters in the playground through the public API, and terrain (M4), vector (M10, M13) and 3D (M13) source interfaces                 | A custom imagery adapter package outside `packages/` (`scripts/fixtures/custom-adapters/`) passes the shared suite          |
| F220                                         | Engine-side validation of source metadata when a source is added                                                                                       | Every adapter refuses bad configuration with a typed `SourceConfigError`                                                    |
| F227                                         | Client-side reprojection of services that offer only other systems (F226)                                                                              | EPSG:3857 and EPSG:4326 requested directly when offered, the preference honored, UTM-only refused with `needs-reprojection` |
| F228                                         | Reprojection of custom tile matrix sets (main track)                                                                                                   | Matrix sets parsed; the levels that match the engine's schemes are used                                                     |
| F234                                         | Reprojection (F226) and image splitting for GPU texture limits in the renderer; the single-image adapter is built with them                            | —                                                                                                                           |
| F235                                         | The terrain adapters of M4 (`heightmapTerrain`, `quantizedMeshTerrain`), owned by the main track                                                       | —                                                                                                                           |
| F258, F259                                   | The live credits list and the built-in attribution element (F254, F255)                                                                                | `viewportCopyright` asks once per settled view (unit test)                                                                  |
| F260                                         | Cache-header-aware reuse in the engine's RAM tier: the transport contract carries no cache headers                                                     | The Google profile declares `respectCacheHeaders`; the fixture server sends `Cache-Control`                                 |
| F264                                         | F254 and F255 for the visible attribution, a vector tile source in M13, and the low-volume live run from a network that reaches the OSMF servers       | Raster profile and its conformance suite; MVT decoding                                                                      |
| F268, F269                                   | The main track's guide sections (composition, reprojection, chains) and the M7 acceptance                                                              | `docs/guides/sources.md` covers adapters, profiles, secrets and custom adapters                                             |
| F337, F339, F551, F554 (data pipeline track) | F254/F255 (credits), F129 (M4 terrain), F247/F248 (source chains)                                                                                      | The PMTiles, MBTiles and MVT adapters these entries load through pass their suites                                          |

3D formats (glTF, 3D Tiles, Google Photorealistic 3D Tiles: F361, F460–F471) belong to M10 and M13 and have no M7 entry.

## Framework adapters track: status

The fifth session's packages are `@vibeglobe/vue` (the `VibeGlobe` component, `useGlobe`, `useCamera`, `useLoading`,
`useViewMode`) and `@vibeglobe/web-component` (`defineVibeGlobe(tagName)`, the `<vibe-globe>` element and its browser
build in `dist/browser/`). Its apps are `apps/adapter-examples` (the Vite + Vue 3 example, React and Vue hosts of the
element, and a plain HTML page) and `apps/nuxt-example`; its end-to-end specs are `e2e/vue-adapter.spec.ts`,
`e2e/web-component.spec.ts`, `e2e/nuxt-example.spec.ts` and `e2e/adapter-leaks.spec.ts` (measurements project).

Shared files it changed, for the main session's review: `scripts/checks/dependencies.ts` (Vue and React allowed in
`apps/adapter-examples`), `scripts/ssr-import.test.ts` and `scripts/bundle-size.ts` (both logged in
`docs/test-changes.md`), `playwright.config.ts` (the examples' dev server on :5180, `adapter-leaks` among the
measurements), the root `build` script (the element's browser build, the examples' vue-tsc check and build, the Nuxt
build), `eslint.config.ts`, `.prettierignore` and `.gitignore` (Nuxt output), and `e2e/globe-leaks.spec.ts`, whose leak
probes moved unchanged to `e2e/support/leaks.ts` for both leak suites.

Passing: F473, F477–F484, F486, F487.

### Stubs for engine features that do not exist yet

| Stub                                     | Where                             | Replaced by                  |
| ---------------------------------------- | --------------------------------- | ---------------------------- |
| `useViewMode()` always answers `'3d'`    | `packages/vue/src/composables.ts` | View modes (F161, F163, M5)  |
| The element has no `view-mode` attribute | `packages/web-component/src/`     | View modes (F161, M5)        |
| Camera props move the camera by `jumpTo` | both adapters                     | Nothing: `jumpTo` is the API |

### Entries waiting for engine features

| Entry | Waits for                                                                                                                                                                                                                   |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F474  | View modes (F161), runtime layer order and visibility (F243–F245), network modes (F271, F292) and quality presets (F399). Camera props already update the engine in place (tested in `e2e/vue-adapter.spec.ts`).            |
| F475  | `flyTo` (F195) for the flight steps and view modes (F161) for the view-mode state. The camera and loading composables are built; the camera follows drags and zooms at most once per frame (tested).                        |
| F476  | Runtime layers and sources (F243–F245), point primitives for markers (F351) and an engine-side control list; child components need an API that adds and removes them on a running engine.                                   |
| F485  | The attribution control and the live credits it shows (F424, F254), which the element must show inside its shadow DOM. Its container is already exposed as part `engine`.                                                   |
| F488  | Every engine feature group of PLAN.md (Map experience through Security): the Nuxt example gains a page per group as each lands.                                                                                             |
| F555  | Network modes and offline packages (F271, F292, M8) and attribution (F254) for the guide's sections, and publishing to npm (owner question 17 in `docs/open-questions.md`) for "installation from the public npm registry". |
| F490  | The entries above; M14's acceptance belongs to the main session.                                                                                                                                                            |
