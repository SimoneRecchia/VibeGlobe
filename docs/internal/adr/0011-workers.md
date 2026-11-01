# 0011. Worker architecture

- Status: Accepted (open points settled by 0015)
- Date: 2026-10-20
- Milestone: M3 (worker pool, decoding, CSP-safe loading); M2 for the rendering-thread evaluation

## Context

`PLAN.md` requires the following:

- Decoding, parsing and mesh generation run in workers, and rendering from a worker with OffscreenCanvas is evaluated.
- Expensive work is spread across frames.
- The engine works under a strict Content Security Policy: no eval or dynamic code generation, and workers and WebAssembly load as separate files from configurable URLs.
- WebAssembly is used only in workers.
- Assets are resolvable by Vite and Nuxt.
- Imports are SSR-safe.
- `destroy()` frees workers, and several engine instances can share a page.
- Offline mode works, and nothing is sent anywhere except the configured sources.

Budgets in `docs/internal/plan/quality.md`: main-thread CPU per frame while moving ≤ 6 ms p95, and steady-state allocations in the frame loop of 0.

The [worker survey](../research/workers.md) studied MapLibre GL JS, CesiumJS, loaders.gl, deck.gl, 3DTilesRendererJS, Potree, OpenLayers, three.js and Vite, together with their issue trackers. It also measured worker costs in headless Chromium:

| Measurement                                           | p50    |
| ----------------------------------------------------- | ------ |
| Spawn a 1 KiB module worker                           | 12 ms  |
| Spawn a 1 MiB module worker                           | 71 ms  |
| Empty round trip                                      | 0.1 ms |
| Transfer 16 MiB                                       | 1.9 ms |
| Clone 16 MiB                                          | 52 ms  |
| Blocking `postMessage` of 50,000 GeoJSON-like objects | 81 ms  |
| 256 px JPEG decode in a worker                        | 3 ms   |

## Options considered

1. **Topology.**
   - **(a) One worker or pool per task type** (CesiumJS `TaskProcessor`, loaders.gl `WorkerPool` per loader, three.js loaders).
     - Pro: simple to write.
     - Con: the worker count grows with every feature, and idle workers of one type cannot help another. Potree crashed Chrome at about 20 workers ([potree #464](https://github.com/potree/potree/issues/464)), and Cesium needs more processor objects for more parallelism ([cesium #11161](https://github.com/CesiumGS/cesium/issues/11161)).
   - **(b) Shared stateful actors with round-robin dispatch** (MapLibre).
     - Pro: bounded worker count.
     - Con: worker-side state leaks (MapLibre's changelog lists leaks on map removal and on aborted tiles; [openlayers #16276](https://github.com/openlayers/openlayers/issues/16276) reached 1.5 GB). Priorities are not global, and per-worker initialization (style parsing) made one worker the fastest choice at startup ([PR #2354](https://github.com/maplibre/maplibre-gl-js/pull/2354)).
   - **(c) A shared pool of generic, stateless workers fed by a central priority queue.**
     - Pro: bounded worker count, global priorities, free cancellation of queued work, crash recovery without lost state, and per-worker initialization limited to loading code.
     - Con: per-source state, such as clustering indexes in M10, needs explicit sessions.
   - **(d) Main thread only, with rAF-scheduled queues** (3DTilesRendererJS).
     - Pro: simplest.
     - Con: image, terrain and MVT work cannot fit the 6 ms budget on tablets ([cesium #13556](https://github.com/CesiumGS/cesium/issues/13556)).
2. **Worker loading.**
   - **(a) Source inlined as a string and started from a `blob:` URL** (OpenLayers, three.js decoders, the Cesium IIFE build): fails `worker-src` without `blob:` ([openlayers #17630](https://github.com/openlayers/openlayers/issues/17630)) and breaks debugging ([maplibre #3613](https://github.com/maplibre/maplibre-gl-js/issues/3613)).
   - **(b) CDN default** (loaders.gl, and through it deck.gl): fails offline, CSP and the privacy rule ([deck.gl #8039](https://github.com/visgl/deck.gl/issues/8039), [loaders.gl #2014](https://github.com/visgl/loaders.gl/issues/2014)).
   - **(c) A global base URL with manual asset copying** (Cesium, Potree): works, but every consumer must configure it ([cesium #8327](https://github.com/CesiumGS/cesium/issues/8327)).
   - **(d) A literal `new Worker(new URL('./file.js', import.meta.url), { type: 'module' })` plus a URL override** (MapLibre v6, the form Vite recommends): detected by Vite, webpack 5 and Parcel, and CSP-clean.
     - Pitfalls: stale shared chunks ([maplibre #8621](https://github.com/maplibre/maplibre-gl-js/issues/8621)), app bundlers re-processing worker code ([maplibre #7339](https://github.com/maplibre/maplibre-gl-js/issues/7339)), Vite dev pre-bundling ([vite #8427](https://github.com/vitejs/vite/issues/8427), [#23785](https://github.com/vitejs/vite/issues/23785)), and silent failure when the file is missing ([maplibre #8018](https://github.com/maplibre/maplibre-gl-js/issues/8018)).
3. **Data transfer.**
   - **(a) Structured cloning of object graphs, with a class registry** (MapLibre): flexible, but it blocks the sender synchronously and invites round-tripping whole datasets ([maplibre #6667](https://github.com/maplibre/maplibre-gl-js/issues/6667)).
   - **(b) Transferables only**: flat typed arrays and `ImageBitmap`s (Potree, OpenLayers, Cesium). Effectively free.
   - **(c) `SharedArrayBuffer`**: requires cross-origin isolation, so every tile host would have to send CORP or CORS headers ([cesium #10502](https://github.com/CesiumGS/cesium/issues/10502)). Incompatible with a map-agnostic engine.
4. **Cancellation.**
   - **(a) Terminate the worker** (loaders.gl): each cancel pays 12–70 ms of startup.
   - **(b) Remove queued tasks and cancel running ones cooperatively** (MapLibre).
   - **(c) No cancellation** (Potree, Cesium in flight).
5. **Rendering thread.**
   - **(a) Main thread** (every studied engine in production).
   - **(b) Worker with OffscreenCanvas** (OpenLayers and three.js examples). Supported on both backends across the browser matrix: WebGL2 in OffscreenCanvas since Chrome 69, Firefox 105 and Safari 17, and WebGPU wherever WebGPU exists.
     - Pro: isolates rendering from host-application jank.
     - Con: input must be forwarded, the synchronous camera, projection and picking API must be mirrored or made asynchronous, and DOM overlays lag the worker frame. OpenLayers' CSS warp of the late frame only works for 2D affine views, not for a perspective globe.

## Decision

Options **1c, 2d, 3b, 4b and 5a**, with the M2 measurement able to switch to 5b. The rules:

1. **Pool.**
   - One pool per resolved worker URL, shared by all engine instances on the page and reference-counted.
   - It is created at runtime by the first `createGlobe` (never at import), which spawns one worker. It grows by one worker when the oldest queued task has waited at least one frame, up to `clamp(hardwareConcurrency − 2, 1, 4)`. The cap can be overridden by a global `workers.maxCount`.
   - The pool never shrinks while in use.
   - When the last engine instance is destroyed, every worker is terminated, every listener removed and every pending task rejected with `AbortError`.
2. **Scheduling.**
   - The pool logic (queue, priorities, cancellation, restarts, lifecycle) lives in `core` against an injected worker-endpoint interface, so it is DOM-free and unit-tested in Node.
   - Tasks enter a binary-heap queue with the scheduler's priority, and the scheduler re-prioritizes or cancels them by handle every frame.
   - Each worker has exactly one task in flight.
   - Cancelling a queued task removes it. Cancelling a dispatched task sends a `cancel` message, which the task checks between its stages (decode, mesh, pack). Workers are never terminated to cancel.
   - Results are applied on the main thread through the per-frame upload budget, never all at once.
3. **Stateless workers.** Built-in tasks are pure functions `(input, options) → output + transfer list`. Per-source state (for example clustering indexes in M10) is an explicit session with an id, explicit release and accounting in the debug overlay.
4. **Data.**
   - **Inputs:** `ArrayBuffer`s fetched by the main-thread scheduler (cancellation, per-host limits, the cache hierarchy and bandwidth estimation stay in one place), always transferred.
   - **Outputs:** `ImageBitmap` (imagery) or flat typed arrays. Meshes carry float32 positions relative to the tile center for both morph targets, plus small plain metadata.
   - **No serialization machinery:** no class instances, no serialization registry, no `SharedArrayBuffer`. The non-transferable part of a message stays under 64 KiB, which debug builds assert.
   - **Image decoding:** happens in the worker with `createImageBitmap(blob, …)`, with orientation, premultiplication and color-space options fixed per backend at decode time.
   - **Exact-value decoding** (DEM): must be pixel-exact even under anti-fingerprinting protection ([maplibre #3110](https://github.com/maplibre/maplibre-gl-js/issues/3110)). The method is chosen in the terrain survey (M4).
5. **Worker program and loading.**
   - A new package `@vibeglobe/worker` (`packages/worker`) builds one self-contained, versioned ES module, `vibeglobe-worker.js`, that hosts the task functions exported by `sources` (and later `layers`).
   - Its main-thread module creates workers with the literal `new Worker(new URL('./vibeglobe-worker.js', import.meta.url), { type: 'module', name })`.
   - `assets.workerUrl` overrides the URL and must be same-origin. A cross-origin URL fails immediately with a typed error; there is no blob shim.
   - Nothing in any bundle uses `blob:` or `data:` workers, `eval`, `new Function` or a CDN fallback.
   - Third-party decoders, and lazily loaded heavy built-in decoders, are separate same-origin module files that every worker imports by URL. Their file names are content-hashed.
6. **Startup and failure handling.**
   - Each worker posts `ready` with the protocol version and build id. A mismatch, or no `ready` within 10 s, emits a typed `worker-error` naming the URL and the likely cause (wrong URL, CSP, HTML fallback).
   - A crashed worker is replaced. A task that exceeds its watchdog (10 s) terminates its worker, fails as `timeout`, and its input is never decoded again (the tile goes to `failed` with backoff).
   - After 3 consecutive start failures, the pool switches to an **inline executor**: the same task functions, loaded lazily on the main thread, running at most one stage per frame. It emits a `worker-fallback` warning. The inline executor is also what Node unit tests use.
7. **WebAssembly.**
   - Runs only in workers. The worker fetches binaries from `assets.wasmBaseUrl`, which defaults to a sibling of the worker file.
   - Decoders are built without dynamic execution (Emscripten `DYNAMIC_EXECUTION=0`), so the worker needs only `'wasm-unsafe-eval'`. Because the worker loads from a real URL, its own response headers can carry that permission while the page CSP stays strict ([cesium #13617](https://github.com/CesiumGS/cesium/issues/13617), [three.js #34389](https://github.com/mrdoob/three.js/issues/34389)).
   - If compilation is refused, the engine uses a JS fallback where one exists, or reports a typed "format unsupported" error.
8. **Rendering thread.**
   - Main thread by default.
   - `core` and `renderer` never touch the DOM. The renderer receives an `HTMLCanvasElement | OffscreenCanvas`, and size, pixel ratio and input come from the host layer, so the M2 experiment can host them in a worker.
   - M2 records the measurements in its own ADR (F065) and adopts worker rendering only if all of these hold:
     - p95 frame interval under synthetic main-thread load (a 30 ms task every 100 ms) improves by at least 25%;
     - p95 without load is no more than 5% worse;
     - added input-to-frame latency is at most 4 ms p95;
     - DOM overlay misalignment is 0 px;
     - all of the above hold on both backends in Chrome, Edge, Firefox and Safari.

## Consequences

- **Plan changes:**
  - Confirms `docs/internal/plan/architecture.md` §2 (shared, reference-counted pool), §7 (worker decoding with transferables after the cache hierarchy) and §13 (literal `import.meta.url` worker files, configurable URLs, no eval or blob code).
  - Adds the package `@vibeglobe/worker` to §1. It depends on `core`, `sources` and later `layers`, so worker tasks from several packages share one worker program and one pool without a dependency from `sources` to `layers`.
  - Adds the global option `workers.maxCount` to `docs/internal/plan/api.md`. `assets.workerUrl` and `assets.wasmBaseUrl` stay as planned.
  - §9 (OffscreenCanvas evaluated in M2) is confirmed with the criteria above.
- **Easier:**
  - Strict-CSP and offline deployments.
  - Vite and Nuxt consumption without configuration in production builds.
  - Deterministic tests: pure task functions in Node, and the pool with fake endpoints.
  - Flat memory: no worker-side tile state.
- **Harder:**
  - Every task must produce flat transferable outputs.
  - Consumers that host assets on another origin must serve the worker from the page origin.
  - Vite dev may need `optimizeDeps.exclude: ['@vibeglobe/worker']`; the M3 tests decide this and the integration guide documents it.
  - Apps that do not use `layers` still ship its worker tasks, within the worker size budget. Lazy task modules are the fallback if the budget breaks.
- **Verification in M3:**
  - Unit tests of the pool: priority order, cancellation in both states, crash and timeout recovery, handshake mismatch, fallback, and that destroying the last instance leaves zero workers and listeners.
  - Fuzzing of every task function.
  - Playwright runs:
    - decoding marks appear only on worker threads (F099);
    - a strict-CSP run without `blob:`, a different asset base URL, and a search of the built bundles for `eval`, `new Function` and blob-generated code (F100);
    - Vite dev and build, and `nuxt dev`/`nuxt build` with a non-root base path.
  - Tracked benchmarks:
    - spawn-to-ready ≤ 50 ms p95 on the reference desktop;
    - worker program ≤ 100 KB min+gzip, excluding lazily loaded WebAssembly;
    - decode throughput and p95 frame time for pool sizes 1–6, which set the default cap;
    - zero engine long tasks over 50 ms while streaming;
    - main-thread cost ≤ 0.3 ms per received tile, excluding upload;
    - decoded-but-discarded tiles below 5% during flights;
    - flat worker count and worker heap in soak tests.
  - A measurement that misses one of these budgets reopens this decision through a new ADR.

## Update 2026-10-20

The owner confirmed same-origin only ([ADR 0015](0015-owner-decisions-2026-10-20.md), decision 11): consumers serve engine assets from their own origin, offline LAN installs included. `assets.workerUrl` and `assets.wasmBaseUrl` stay configurable; no CDN support is planned (follow-up list).

## Update 2026-10-21

Decision 8's measurement ran in M2 ([ADR 0019](0019-offscreencanvas-evaluation.md)). Worker rendering added input latency and misaligned DOM overlays, so rendering stays on the main thread. The renderer keeps its OffscreenCanvas path.
