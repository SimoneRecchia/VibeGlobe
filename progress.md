# Progress

## Current state

- **M2 Globe core complete** (F078 passing, 2026-10-21: the full CI suite green on 9679fe0, reviews closed by ADR 0021, no open bug). Passing in M2: F042–F064, F066–F074, F076–F078; pending owner steps: F065, F075.
- Also passing: F546 (initial-JavaScript budgets, start-up median 456 ms), F547 (lazy loading, `apps/lazy-host`). Pending owner steps: F065 (OffscreenCanvas measured and not adopted, ADR 0019; other browsers on real GPUs) and F075 (hardware procedure, `docs/guides/hardware-testing.md`).
- **M3 Imagery streaming complete** (F125, 2026-10-22: the full CI run green on 0f18b8b; docs/plan/m3-imagery-streaming.md). Passing: F079–F114, F116–F121, F125, F562–F564; pending owner step: F115 (start-up budget on a real GPU: 9.8 s on the software GPU of the container, docs/open-questions.md); superseded by ADR 0023: F122–F124 (replaced by F562–F564). One fresh-context review: findings fixed as KB-070 to KB-073 plus three requirement gaps; no open bug.
- M3 took about 14 hours of agent time (2026-10-21 13:20 to 2026-10-22 03:10 UTC, groundwork included): about 9.5 hours of features and 4.5 hours of making the full CI run green on its software GPU (eight single-worker end-to-end shards, isolated measurements one at a time, KB-074 and KB-075, test timing fixes logged in docs/test-changes.md). Remaining: M4 to M15, 413 active entries. Estimate to M15 at the M3 pace (about 3 entries per hour including CI stabilization): 110 to 140 hours of agent time, plus the owner-only steps in docs/open-questions.md.
- Owner questions open: `docs/open-questions.md` 2 and 13–17; questions 18 and 19 were decided by the agent (ADR 0018, ADR 0012) and may be revisited.

## Data pipeline track (second session, `packages/tools`)

Branch `claude/tools-offline-builder-uvuuxe`, pull request SimoneRecchia/VibeGlobe#6; status and blockers in `docs/parallel-tracks.md`.

- **2026-10-21:** `vibeglobe-data` CLI (ADR 0024): estimate with cost and confirmation, license gate, resumable steps with SHA-256 checks, built-in GeoTIFF reader, PNG, JPEG and Terrarium encoders, PMTiles and MBTiles writers, OSM PBF to MVT, GDAL only in a digest-pinned Docker image (convert hook and `verify`). Configurations `world-low`, `italy-high`, `test-mont-blanc` with lock files. Licenses re-verified (ADR 0025, `docs/data-licenses.md`), dataset-build skill, hosting guide. Verified on real Copernicus DEM (Mont Blanc) and the real Natural Earth fallback; Sentinel-2 cloudless and OSM through fixture stubs (owner question 21; Geofabrik is not reachable from the container). Browser checks: `npx playwright test -c packages/tools/playwright.config.ts`.
- **2026-10-22:** Detailed imagery switched to the ESA WorldCover 2021 Sentinel-2 RGBNIR composite (owner answer to question 22, ADR 0026): windowed COG reads with range requests, a fixed colour stretch (B04, B03, B02; `255 × min(1, r / 3000) ^ 0.5`), composite gaps filled by WorldCover land-cover class, sea at the measured median sea colour. Verified on real data: Mont Blanc sample (74 MB instead of 2.3 GB), Gulf of Naples, and the world-low sample at overview 4. Merged `main` after pull request SimoneRecchia/VibeGlobe#7.
- Passing: F330–F335, F338, F340, F343–F346, F552, F553, F307. F553's check: the playground's production build ran from a plain static server (`http-server` with CORS and ranges, Docker Hub being rate-limited for nginx), with the worker and base image under `/static/vibeglobe/` and the sample tiles; every request answered 200 and the zoom-5 frame had no empty pixel. Following the guide also showed that the unbundled worker cannot be served as is; the guide now says to serve the bundled one. Waiting on main-track engine capabilities (adapters, attribution, source chains, offline mode): F336, F337, F339, F341, F304, F305, F551, F554.
- Notes: Docker Hub rate-limits this container's pulls intermittently, and GHCR blobs are blocked, so the configurations pin `docker.io/osgeo/gdal:ubuntu-small-3.6.3` by digest. Raster tiling runs at about 0.1 s per 256-px tile on one core, and the OSM reader holds the needed nodes in memory: both are noted in `docs/follow-ups.md` for full builds.

## Source adapters track (fourth session, `packages/sources`)

Branch `claude/m7-source-adapters-0gkrjg`; status, contract workarounds and what each remaining entry waits for in `docs/parallel-tracks.md`.

- **2026-10-22:** Adapters on the frozen source contract (ADR 0030): PMTiles (range requests, `pmtiles` library), MBTiles (`sql.js`, `@vibeglobe/sources/mbtiles`), WMTS and WMS (capabilities, CRS choice, gutter cropping), GeoJSON, KML/KMZ, GPX and a validating MVT decoder (`@vibeglobe/sources/vector`, worker task table), Google Map Tiles API 2D and Street View with session renewal (ADR 0031), the OpenStreetMap public-servers profile (ADR 0032). Shared, framework-free conformance suites (`@vibeglobe/sources/conformance`), an opt-in live run (`npm run test:live-sources`), the survey `docs/research/source-adapters.md` and the guide `docs/guides/sources.md`.
- Passing: F223, F230–F233, F236–F239, F256, F257, F261–F263, F265–F267, and F341 of the data pipeline track. Pending the owner: F549 (one live run with the Google key). Waiting on the main track: F218–F220, F227, F228, F234, F235, F258–F260, F264, F268, F269.
- Notes: the container reaches GitHub but not Google's, the OSMF's or most OGC servers, so the terms were read through search excerpts (owner question 24) and recorded capabilities come from the OpenLayers and OWSLib test suites. Fixed during development: concurrent Google 401s created one session per tile (now one renewal per refused token, unit test).

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
