# Progress

## Session state (main session, branch `claude/wizardly-archimedes-up4ww2`, 2026-10-25 06:30 UTC)

Handoff: the main session's branch is `claude/wizardly-archimedes-up4ww2`. Merged into `main` so far: #26, #27, #30,
#32, #35–#40, #42 (04:35 UTC). SimoneRecchia/VibeGlobe#43 carries everything since (track I's space background, F600–F609,
included: #41 is superseded by it and stays for the owner to close); merge it by about 08:30 UTC. GitHub deletes the
branch on merge: the next push recreates it. A full manual CI run on 29727ec (run 40168874917) was in progress at the
handoff; its failures are the next work.

Owner decisions of 2026-10-24 and 25 (ADR 0046): retry rounds after connectivity returns (TG-05); F395 superseded by
F574; F148, F167, F389 in the hardening backlog with KB-097, KB-110, KB-170, KB-171; F403, F472, F453 pending; the
reference desktop is the owner's MacBook Pro M5, no reference tablet (`docs/plan/quality.md`).

Since the last handoff (2026-10-25 04:45):

- Fixed: KB-138 (the bandwidth estimate fits each transfer's time against its bytes and leaves out a fixed
  per-response delay), the M8 fix-check's gaps KB-192 (offline-only scopes are never health-checked), KB-193 (terrain
  package credits), KB-194 (held misses no longer keep the engine busy; one endpoint returning wakes its tiles),
  KB-195 (F298 step 3 checked), KB-196 (the playground installs a world package), and KB-197 (release dry run: the Cube
  check reads large files), KB-198 (package areas reaching 180° covered one column only).
- F052 expects the stitch binding's start-up height grid (9 uploads). The network-mode matrix checks popping in still
  frames on a stepped clock (F329 step 3).
- Remaining M4–M14 outside the backlog: F329 only. Its steps are covered (the review and its fix-check are done, no M8
  bug is open); it is marked once the full CI run passes its network suites and matrix.
- Open elsewhere: KB-180's wedges and KB-181 (the owner's exact views are asked for), TG-04 (vector recovery), the WebGL2
  CPU budget (the next hardware run's `phaseMedianMs` shows where the fixed 4.9 ms per frame goes).

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
