# Parallel tracks

Since 2026-10-21 several Claude Code sessions work on the repository at the same time (owner's decision). Each session edits only what it owns; anything else it needs from the other track arrives as a pull request that the owning session reviews.

| Track                                               | Session                                                   | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine (M3–M8, M10, M11, M13–M15; M12's acceptance) | Main session, branch `claude/happy-galileo-b07j98`        | Every package and app except those of the other tracks below; in M7, layer composition, reprojection and color harmonization; in M8, memory reuse and prefetch in the loader (F281–F285), motion-aware detail (F288), bandwidth estimation and adaptation (F300–F303) and the acceptance (F329); M12's and M14's acceptance (F438, F490); every `feature_list.json` entry not listed below                                                                                                                                                                |
| Data pipeline and offline package builder           | Second session, its own branch, pull requests into `main` | `packages/tools` (the command-line tools); M9, data pipeline and default datasets (F330–F347, F551–F554); the offline package builder CLI (F304, F305, F307); the `status` of those entries in `feature_list.json` and their records in `docs/`                                                                                                                                                                                                                                                                                                           |
| UI and GIS utilities (M12)                          | Third session, its own branch, pull requests into `main`  | `packages/ui` (its existing debug overlay included) and a GIS utilities package of its own: coordinate parsing and formatting, CRS transforms, geodesic measurement, view-state serialization; M12 entries F404–F437 and their records in `docs/`                                                                                                                                                                                                                                                                                                         |
| Source adapters of M7                               | Fourth session, its own branch, pull requests into `main` | In `packages/sources`, every M7 source adapter except the XYZ imagery adapter (`xyz-imagery.ts`) and `fetchTransport`, with the Google and OpenStreetMap provider profiles; those entries' `status` in `feature_list.json` and their records in `docs/`                                                                                                                                                                                                                                                                                                   |
| Framework adapters (M14)                            | Fifth session, its own branch, pull requests into `main`  | `packages/vue`, `packages/web-component` and a minimal Nuxt example app (`apps/nuxt-example`), built on the engine's public API only; M14 entries F473–F488 and F555, their `status` in `feature_list.json` and their records in `docs/`                                                                                                                                                                                                                                                                                                                  |
| Offline engine (M8)                                 | Sixth session, its own branch, pull requests into `main`  | `packages/offline`: persistent cache and storage backends, quotas and eviction, cache policy and revalidation, offline package management, versions and integrity checks, network modes (online only, offline only, hybrid), connectivity detection, the loading switches and their per-layer overrides, provider-rule enforcement for caching and packaging, flight preloading once `flyTo` exists; M8 entries F270–F280, F286, F287, F289–F299, F306, F308–F319, F326–F328 and F550, their `status` in `feature_list.json` and their records in `docs/` |

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

Hooks a track needs in a package it does not own. The requesting session adds a row; the main session answers in the
last column (landed on `main`, or why not) and announces any change to the source contract above.

| Date       | Track               | Hook needed (package, API, why)                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Answer |
| ---------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 2026-10-22 | Offline engine (M8) | (1) `packages/core`: honour per-source loading decisions in the imagery loader, through a `NetworkPolicy`-like hook (`keepInMemory`, `prefetch`) that `@vibeglobe/offline` resolves from the mode, the switches and the provider profile. Without it the memory-reuse and prefetch switches are stored and resolved but core ignores them (F271, F290, F314; shared with F281–F285).                                                                                                                  |        |
| 2026-10-22 | Offline engine (M8) | (2) `packages/core`: `Globe.reloadSource(sourceId)` (or an invalidation event) that drops a source's GPU and RAM tiles and its no-data marks, so a new package version or a switch from offline-only to hybrid reaches tiles already in memory without recreating the globe (F279, F312 seamless; today the harness recreates the globe).                                                                                                                                                             |        |
| 2026-10-22 | Offline engine (M8) | (3) `packages/core` (optional): a transport result `offline` that parks a tile until a resume signal, replacing the offline track's hold-and-abort workaround (a miss while an endpoint is unreachable is held 500 ms, then answered `aborted`), and that counts as settled for `Globe.ready`: today a start with the network down and no data for the pinned levels keeps `ready` pending until connectivity returns.                                                                                |        |
| 2026-10-22 | Offline engine (M8) | (4) `apps/playground`: wrap its fixture sources with `createOffline().source()`, add `?network=online\|offline\|hybrid`, and show the per-tier counters (`Offline.stats()`) in the debug overlay (`?debug=1`). The offline specs use `e2e/support/offline.html` on the playground's dev server meanwhile (F272, F291–F293 name the playground).                                                                                                                                                       |        |
| 2026-10-22 | Offline engine (M8) | (5) `playwright.config.ts`: add `offline-browsers.spec.ts` (WebGL-free storage checks) to `CROSS_BROWSER_SPECS`, so CI's Firefox and WebKit job runs them (F273, F276 ask for all three browsers; the container cannot download Firefox or WebKit). Proposed in the offline track's pull request together with Firefox's `dom.storageManager.prompt.testing` prefs, which answer `persist()`'s permission prompt headless; CI runs 39822457570 and 39831959616 pass both specs in Firefox and WebKit. |        |

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

## Offline engine track (sixth session): status

Branch `claude/gifted-mayer-p0kexd`. `@vibeglobe/offline` (ADR 0029, survey `docs/research/offline-and-network.md`,
guide `docs/guides/offline.md`): tier wrapper for sources (`createOffline().source()`), IndexedDB cache in a worker,
cache policy and revalidation, connectivity from health checks, network modes and loading switches, the package manager
(install, list, update, remove, integrity, resumable installs, in-browser builds), and the Docker LAN server
(`packages/offline/lan-server/`). Browser specs: `e2e/offline-*.spec.ts`, on the harness page
`e2e/support/offline.html` of the playground's dev server, because the playground's own sources do not go through the
offline package yet (hook requests above).

### Stubs

| Stub                                                                           | Where                                                   | Replaced by                                                             |
| ------------------------------------------------------------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------------- |
| PMTiles and MBTiles adapters (`ArchiveAdapters`, the M7 signatures)            | `packages/offline/src/__fixtures__/archive-adapters.ts` | `pmtilesImagery`, `mbtilesImagery` of `@vibeglobe/sources` (F232, F233) |
| Provider rules (`ProviderRules`, structurally the adapters' `ProviderProfile`) | `packages/offline/src/types.ts`                         | The adapters' `ProviderProfile` (M7), passed as is                      |

### Entries waiting for engine features

| Entry                        | Waits for                                                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F271                         | Memory reuse and prefetch acting in core (F281–F285, hook request (1)); the playground's own sources wrapped (hook request (4))                                |
| F272                         | The per-tier counters in the playground's debug overlay (hook request (4)); the persistent, package and network tiers are counted                              |
| F286, F287                   | `flyTo` (F195) and motion-aware detail (F288)                                                                                                                  |
| F290                         | Memory reuse and prefetch switches acting in core (hook request (1)); per-layer scopes for layer chains (F247)                                                 |
| F292–F296, F298              | Flight scenarios (`flyTo`, F195); their zoom and pan parts are covered by the network, package and LAN specs                                                   |
| F304, F305, F336             | The PMTiles and MBTiles adapters on `main` (F232, F233); the packages load through the typed stub meanwhile                                                    |
| F306                         | The live credits and the attribution element (F254, F255)                                                                                                      |
| F314                         | Hook request 1 and flight scenarios (F195)                                                                                                                     |
| F315, F316                   | Flight scenarios (F195) and prefetch with flight preloading (F284, F286) in the scenario suite                                                                 |
| F326                         | The fourth session's shared conformance suite with profile-enforcement checks, the attribution element (F255) and core honouring a profile's concurrency limit |
| F328                         | The terrain and MVT adapters (F129, F239) and terrain in core (M4)                                                                                             |
| F337, F339, F341, F551, F554 | As listed for the data pipeline track above (F254/F255, F129, F239, F247/F248)                                                                                 |
