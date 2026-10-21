# Milestones and task breakdown

The 15 milestones of `PLAN.md`, in build order. Each closes only when every `feature_list.json` entry with its milestone number passes (including its acceptance entry) and a fresh-context reviewer finds no correctness or requirement gaps. `npm run status` shows progress per milestone; within a milestone, work follows the order of `feature_list.json` (file order is priority order).

Before each subsystem: write or update its research survey in `docs/research/`, then record the chosen design in an ADR.

## M1 Research and foundation

Done when: the core research survey is written, CI is green and the playground runs.

Research first: precision, depth, terrain and imagery levels of detail, tile scheduling and caching, globe-to-flat transitions, camera control, GPU resource management and renderer backends, worker usage, rendering tests and benchmarks.

1. Research survey for the core areas (subagents in parallel, one area each), indexed in `docs/research/README.md`.
2. Scaffold every package of the architecture (ESM, `sideEffects: false`, declarations, per-package CLAUDE.md), dependency-rule check (no framework in core, three.js only in renderer).
3. Formatter and linter (no `any`, TSDoc on public API, no dead code), Claude Code hooks for format, lint and type check.
4. Unit test runner with coverage thresholds (90% lines for core logic); SSR-safe import test for every package.
5. CI: type check, lint, unit tests, end-to-end smoke, API docs build, license audit (fails on copyleft) with generated third-party notices.
6. Benchmark harness with budgets (frame CPU/GPU, memory, bundle size per package) that fails on breach.
7. Documentation site scaffold; ADR and progress-log conventions (already started in session 1).
8. Playground shell with a scenario hook and the debug overlay skeleton (backend selection arrives with the renderer in M2).
9. Owner decisions of 2026-10-20 (ADR 0015): rename to VibeGlobe, PolyForm Noncommercial license with the contributor documents, CI split into a fast job on every push and the full suite on `main` and nightly (F542–F545).

## M2 Globe core

Done when: zooming from orbit to about 1 m above the ground shows no jitter and no z-fighting on both backends.

Prerequisites: precision, depth, GPU and camera surveys; ADRs for precision, depth and renderer base.

1. float64 math library (pooled vectors, matrices, quaternions) and WGS84 geodesy (geodetic ↔ ECEF ↔ ENU, ellipsoid normals, ray–ellipsoid intersection) with property-based tests.
2. Camera model (position, heading, tilt, field of view, zoom ↔ altitude), screen ↔ globe projection.
3. `RendererBackend` interface; three.js implementation at a pinned version with WebGPU and WebGL2 fallback, forced-backend option, capability detection, clear error without WebGL2.
4. Precision (camera-relative rendering with float64 origins and split per-draw offsets, ADR 0004) and depth (reversed-Z float depth with an infinite far plane; fragment-written depth on WebGL2 without clip control, ADR 0005 and ADR 0013).
5. Globe mesh with pinned low-resolution imagery (bundled, permissively licensed).
6. Basic drag (rotate the globe under the cursor) and zoom.
7. Render on demand, background throttling, zero-allocation frame loop, resize and pixel-density handling, device/context loss recovery, `destroy()` and multiple instances.
8. Visual regression harness of canonical views on both backends; CI runs WebGL2 and WebGPU through SwiftShader (ADR 0012); documented local procedure for real GPUs; OffscreenCanvas evaluation ADR.
9. The ADR 0012 probes on Playwright's pinned Chromium in CI, start-up measurement (navigation to `ready`) and steady-state allocation sampling in the benchmark harness (ADR 0013).
10. Initial-JavaScript budget (ADR 0015, decision 12): measure three.js after tree-shaking, set the byte budget from it with a blocking CI size check, time to first frame as the binding target, and lazy loading of the engine through a dynamic import (F546, F547).

## M3 Imagery streaming

Done when: scripted zoom and pan scenarios show zero black pixels and no popping.

Prerequisites: level-of-detail, scheduling and caching, and worker surveys; the compression survey (KTX2/Basis, Draco, meshopt) before step 7.

1. Tiling schemes and packed tile keys; quadtree traversal with screen-space error; frustum and horizon culling.
2. Tile state machine, parent fallback, pinned base, lazy refinement.
3. Request scheduler: priorities, per-host concurrency, cancellation, retries with backoff, timeouts, coalescing, no-data handling and declared coverage.
4. Worker pool and image decoding; configurable worker URLs; strict CSP compatibility.
5. RAM cache and GPU/RAM budgets with LRU; per-frame upload budget.
6. Cross-fade, seam-free sampling, mipmaps, color space, high-DPI and resolution scale, poles and antimeridian.
7. KTX2/Basis transcoding where the device benefits.
8. Complete debug overlay, performance marks and HUD, logging and tracing.
9. Scenario harness: scripted camera paths, per-frame capture, black/background pixel detection, frame differencing for popping, flicker and seams; fuzzing of image decoders.

## M4 Terrain

Done when: no cracks, correct relief, and the camera never enters the terrain.

Prerequisite: terrain level-of-detail survey (part of the M1 level-of-detail survey).

1. Terrain adapters: quantized-mesh, Terrarium, Terrain-RGB (decoders in workers, fuzzed).
2. Height grids from every terrain source and per-tile meshes (globe and plane offsets) built in workers, with shared index buffers per grid size; RTIN-style simplification only as a measured fallback (ADR 0006, ADR 0013). Bounding volumes with height ranges.
3. Skirts, time-based geomorphing, independent terrain and imagery levels within one surface quadtree (ADR 0006).
4. Elevation queries: synchronous best-available, asynchronous most-precise.
5. Terrain collision for the camera.

## M5 Globe, map and 3D view

Done when: a continuous zoom from the globe to an oblique street view is smooth at the target frame rate, with no jumps.

Prerequisite: globe-to-flat survey.

1. Flat map projection and the GPU morph between ellipsoid and plane.
2. Anchor-preserving morph (cursor or screen center fixed).
3. Zoom-driven tilt and relief curves that ease in and out at their ends, with a 0° 2D band and tilt rising only at neighborhood scale (ADR 0015, decision 9); relief scaled by the projection scale factor on the flat plane.
4. View modes (Auto, 2D locked, manual) and chosen vs applied tilt and heading.
5. Long flights passing through the phases.

## M6 Navigation

Done when: every listed interaction works on desktop and tablet.

Prerequisite: camera control survey (written in M1, extended here).

1. Gesture recognizers for mouse, trackpad, touch and keyboard; inertia.
2. Every zoom, pan, rotate and tilt interaction of `PLAN.md`; compass and orientation behavior.
3. `flyTo`, `jumpTo`, `easeTo`, tours: cancellable, promise-based, evented, honoring view-mode rules.
4. Coordinate entry (decimal degrees, DMS, UTM) and the geocoder interface.
5. Constraints (zoom, tilt, bounds, terrain collision), reduced motion, frame-rate independence, smooth interruption.

## M7 Sources and composition

Done when: each adapter passes its conformance suite and a mixed stack switches sources without visible seams.

Prerequisite: sources, formats and reprojection survey; ADRs reading Google's and OpenStreetMap's current terms.

1. Final adapter interface and source metadata; conformance-suite framework with fixtures.
2. Imagery adapters (XYZ/TMS, WMTS, WMS, PMTiles, MBTiles, georeferenced image), tile sizes, @2x, image formats, tiling schemes, reprojection.
3. Vector adapters (GeoJSON, KML, GPX, MVT decoding) and 3D adapters (glTF; 3D Tiles in M13).
4. Layer stack, source chains, color harmonization.
5. Provider profiles and enforcement (Google, OpenStreetMap public and self-hosted, custom), live attribution, CORS and authentication.
6. Live Google tests through a separate command with the `GOOGLE_MAPS_API_KEY` key, EEA terms, within the free monthly caps, stopping on a quota error (ADR 0015, decision 5; F549).

## M8 Offline and adaptive loading

Done when: the network scenarios pass (offline, slow, flaky, connection dropping and returning), and every combination of network mode and loading-feature switch behaves as specified.

Prerequisite: offline, storage and network adaptation survey.

1. Network modes and loading switches with the policy resolver; cache hierarchy.
2. Persistent cache stores, quotas and persistence requests.
3. Offline package format, LAN-server mode, device mode, package management API, package builder.
4. Connectivity monitor and bandwidth estimator; flight preloading; motion-aware detail.
5. Network simulation scenarios; every combination of mode and switch.
6. Docker-based static LAN server script for offline mode 1, used by its tests (ADR 0015, decision 3; F550).

## M9 Data pipeline and default datasets

Done when: the default datasets rebuild reproducibly from configuration.

Prerequisite: data pipeline tooling survey.

1. CLI framework in `tools`, versioned configuration files, size and cost estimates with confirmation before any download, resumable steps, license records.
2. Copernicus DEM GLO-30 to terrain tiles; Sentinel-2 cloudless 2016 to imagery pyramids; Natural Earth fallback; OpenStreetMap extracts to vector tiles.
3. Ready-to-run world low-detail and Italy high-detail configurations, verified on small sample areas (consumers run the full builds on their own AWS account; ADR 0015, decision 4); offline packages and static tile folders; licenses re-verified.
4. Hosting guide for consumers: tiles, packages and engine assets on their own backend and frontend (F553).

## M10 Data layers

Done when: 100,000 points with clustering stay at the target frame rate, and draped shapes follow terrain at every level.

Prerequisite: picking, labels and data-layer surveys.

1. Primitives and batching; placement modes (draped, ground-clamped, absolute).
2. Styling expressions; live updates; clustering and marker LOD.
3. SDF labels with collision and priorities.
4. Picking (features and bare terrain) and interaction events; glTF models.

## M11 Atmosphere and quality

Done when: adaptive quality holds the target frame rate on the reference tablet.

Prerequisite: atmosphere and lighting survey.

1. Sky, atmosphere, haze and fog (with fewer loads near the horizon), sun lighting by date and time.
2. Anti-aliasing per backend, anisotropic filtering.
3. Quality presets, per-device defaults, adaptive quality.

## M12 GIS utilities and UI

Done when: every control works with mouse, touch and keyboard alone.

1. Cursor readout, coordinate formats and CRS transforms, geodesic measurements, drawing and measuring tools, scale bar, geolocation, view state and bookmarks, screenshot export, minimap.
2. UI package: every ready-made control, theming, English and Italian, accessibility.

## M13 Vector tiles, buildings and 3D Tiles

Done when: a city view with roads, labels and buildings meets the performance targets.

Prerequisite: vector tiles, buildings and 3D Tiles survey.

1. MVT rendering on the globe and the flat map with MapLibre styles.
2. OpenStreetMap roads, places and building extrusions.
3. 3D Tiles streaming; Google Photorealistic 3D Tiles under its profile.

## M14 Framework adapters

Done when: the Nuxt example builds with SSR and runs every feature on the client, and the Web Component works in a plain HTML page.

1. Vue 3 adapter; Web Component; Nuxt example with SSR and hydration tests; integration guide (npm installation, licensing, lazy loading, asset hosting).

## M15 Hardening and release

Done when: every item in the Definition of done is ticked.

1. Reference-device performance pass, hardware/OS and browser matrices, soak and chaos tests, aggregate fuzzing, lifecycle edge cases.
2. Complete documentation and examples, API review, release automation, 1.0.0 published to npm under `@vibeglobe` with the owner's approval; the repository made public by the first release (F561).
3. Before M15 starts, ask the owner again about a cloud device service (ADR 0015, decision 2).
