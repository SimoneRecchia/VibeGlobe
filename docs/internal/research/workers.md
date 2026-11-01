# Worker usage

- Status: Complete (survey for M2 and M3)
- Date: 2026-10-20
- Decision: [ADR 0011](../adr/0011-workers.md)

## 1. Scope and requirements

This survey covers moving decoding, parsing and mesh generation off the main thread. It looks at how workers are organized and sized, how tasks are scheduled and cancelled, and how data crosses threads (structured clone, transferables, `SharedArrayBuffer`). It also covers loading workers and WebAssembly under a strict Content Security Policy (CSP) and through Vite, Nuxt and webpack, and rendering from a worker with `OffscreenCanvas`.

PLAN.md requirements it serves:

- **Engineering standards, "Free main thread":** decoding, parsing and mesh generation run in workers. Rendering from a worker with OffscreenCanvas is evaluated where the browser supports it.
- **Tiles, level of detail and streaming:** work stays "Off the main thread", and expensive work is spread across frames ("Frame budget").
- **Security, robustness and licensing compliance:**
  - Content Security Policy: no eval or dynamic code generation, and "workers, WebAssembly and other assets load as separate files from configurable URLs".
  - `destroy()` frees workers.
  - Several engine instances can run on one page.
- **Architecture guidance:** WebAssembly is used only in workers.
- **Documentation and distribution:** workers and WebAssembly assets are resolvable by bundlers (Vite, Nuxt) or loaded from configurable URLs.
- **Fixed constraints:** importing a package is SSR-safe, offline mode works, and nothing is sent anywhere except the configured sources.
- **Feature list:** F014 (this survey), F065 (the OffscreenCanvas ADR, M2), F099 and F100 (decoding in workers and strict CSP, M3), F518 (full CSP run, M15), and the `destroy()` and mount/unmount entries.

## 2. Projects studied

| Project                  | Version / commit                                                                     | License      | Files read                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MapLibre GL JS           | 6.15.0, `main` [`95c7031`][ml]                                                       | BSD-3-Clause | `src/util/{worker_pool,web_worker,global_worker_pool,dispatcher,actor,throttled_invoker,web_worker_transfer,offscreen_canvas_distorted,util,ajax}.ts`, `src/source/{worker,vector_tile_worker_source,raster_dem_tile_worker_source}.ts`, `rolldown.config.ts`, `test/build/esm.test.ts`, `src/util/web_worker.test.ts`, `src/source/worker_tile.bench.ts`, `test/bench/README.md`, `CHANGELOG.md` |
| CesiumJS                 | 1.146.0 (`@cesium/engine` 26.4.0), [`621826d`][ce]                                   | Apache-2.0   | `packages/engine/Source/Core/{TaskProcessor,buildModuleUrl,TerrainData,QuantizedMeshTerrainData,TerrainPicker,Resource}.js`, `Source/Workers/createTaskProcessorWorker.js`, `Source/Scene/{Primitive,GltfDracoLoader}.js`, `Specs/Core/TaskProcessorSpec.js`, `scripts/build.js`                                                                                                                  |
| loaders.gl               | 5.0.0-alpha.12, [`a6120f5`][lg] (4.x `@loaders.gl/worker-utils` has the same design) | MIT          | `modules/core/src/worker-utils/lib/worker-farm/{worker-farm,worker-pool,worker-thread,worker-job}.ts`, `worker-api/{get-worker-url,process-on-worker}.ts`, `worker-utils/{get-loadable-worker-url,get-transfer-list}.ts`, `lib/loader-utils/option-defaults.ts`, `worker-pool.spec.ts`, `modules/draco/test/draco.bench.ts`                                                                       |
| deck.gl                  | 9.4.0-beta.4, [`cb353ad`][dg]                                                        | MIT          | `modules/geo-layers/src/{mvt-layer/mvt-layer,terrain-layer/terrain-layer}.ts`, `modules/core/src/lib/deck.ts`, `test/bench/`                                                                                                                                                                                                                                                                      |
| 3DTilesRendererJS        | 0.5.3, [`3febfcf`][tt]                                                               | Apache-2.0   | `src/core/renderer/tiles/TilesRendererBase.js`, `src/core/renderer/utilities/{PriorityQueue,Scheduler}.js`, `src/three/plugins/images/sources/TiledImageSource.js`, `src/three/plugins/images/terrain-rgb/GridCache.js`, `test/core/PriorityQueue.test.js`                                                                                                                                        |
| Potree                   | 1.8.0 (`develop`), [`5636cd4`][po]                                                   | BSD-2-Clause | `src/WorkerPool.js`, `src/Potree.js`, `src/modules/loader/2.0/{OctreeLoader,DecoderWorker}.js`, `src/utils.js`, `rollup.config.js`                                                                                                                                                                                                                                                                |
| OpenLayers               | 10.11.1-dev, [`60b34fc`][ol]                                                         | BSD-2-Clause | `tasks/serialize-workers.cjs`, `src/ol/worker/{webgl,textOverlay}.js`, `src/ol/render/webgl/VectorStyleRenderer.js`, `examples/offscreen-canvas{,.worker}.js`, `test/browser/vite-plugin-ol-worker.mjs`, `test/browser/spec/ol/worker/webgl.test.js`                                                                                                                                              |
| three.js (renderer base) | r186 dev, [`f480849`][th]                                                            | MIT          | `examples/jsm/loaders/{DRACOLoader,KTX2Loader}.js`, `examples/jsm/utils/WorkerPool.js`, `examples/webgl_worker_offscreencanvas.html`, `src/renderers/common/{Renderer,Backend}.js`                                                                                                                                                                                                                |
| Vite (bundler)           | 8.3.4, [`2601eed`][vi]                                                               | MIT          | `docs/guide/features.md` (Web Workers, CSP), `docs/config/worker-options.md`                                                                                                                                                                                                                                                                                                                      |

Browser support figures come from `@mdn/browser-compat-data` 8.1.6.

## 3. How each project solves it

**MapLibre GL JS.**

- **Pool:** one page-wide [`WorkerPool`][ml-pool] is shared by every map and reference-counted by map id. When the last map releases it, the workers are terminated. `prewarm()` keeps the pool alive across navigations in single-page apps.
- **Dispatch:** each map's [`Dispatcher`][ml-disp] wraps every worker in an `Actor` and hands out actors round-robin.
- **Stateful workers:** workers keep per-map state, such as loaded tiles that can be reparsed and GeoJSON indexes.
- **Worker count:** one worker in Chromium and Firefox. On Safari it is half the cores, capped at 3. Bing's A/B tests ([PR #2354](https://github.com/maplibre/maplibre-gl-js/pull/2354)) found that one worker reached first idle about 2% sooner, because every worker initializes itself and parses the whole style. Felt later measured the last tile loading about 25% faster with 4 workers on heavy data. `setWorkerCount` overrides the default.
- **What runs in the worker:**
  - Vector tiles: fetch (made inside the worker; [`ajax.ts`][ml-ajax] proxies only custom protocols back to the main thread), parsing, bucket building and GeoJSON indexing.
  - Raster imagery: decoded on the main thread with `createImageBitmap`.
  - DEM tiles: decoded to an `ImageBitmap` on the main thread and transferred. The worker then reads the pixels with an OffscreenCanvas 2D `getImageData`. A probe ([`offscreen_canvas_distorted.ts`][ml-ocd]) detects anti-fingerprinting noise, and in that case the worker reads pixels with WebCodecs `VideoFrame.copyTo` instead.
- **Messaging:** messages carry random string ids. [`web_worker_transfer.ts`][ml-ser] serializes registered classes by name and moves every `ArrayBuffer`, typed-array view and `ImageBitmap` into the transfer list.
- **Cancellation:** a `<cancel>` message. The worker queues incoming tasks and runs one per `MessageChannel` tick ([`ThrottledInvoker`][ml-ti], with a `setTimeout` backup because WebKit can close the ports), so cancels can arrive between tasks.
- **Worker loading:** since v6 the worker is a separate, self-contained `maplibre-gl-worker.mjs`. Its default URL is `new URL('./maplibre-gl-worker.mjs', import.meta.url)` plus `?v=<version>` ([`web_worker.ts`][ml-ww]), and `setWorkerUrl` overrides it.
- **Cross-origin URLs:** these get a blob shim containing `import "<url>"`, which requires `worker-src blob:`.
- **Build:** [`rolldown.config.ts`][ml-build] builds the main bundle and the worker separately, so no shared chunk can go stale on its own ([#8621](https://github.com/maplibre/maplibre-gl-js/issues/8621)). v6 dropped the CSP bundle: once the worker loads from a real URL, `worker-src blob:` is not needed.
- **OffscreenCanvas rendering:** none. The request in [#239](https://github.com/maplibre/maplibre-gl-js/issues/239) went stale.

**CesiumJS.**

- **One worker per task type:** a [`TaskProcessor`][ce-tp] owns exactly one module worker for one task type ([#11161](https://github.com/CesiumGS/cesium/issues/11161)), created lazily on the first `scheduleTask`. Modules create processors at load time:
  - each terrain format has a throttled and an unthrottled mesh processor, plus an upsample processor;
  - `Primitive` creates `hardwareConcurrency − 1` geometry processors.

  A varied scene therefore runs many workers.

- **Back-pressure:** a processor accepts at most `maximumActiveTasks` tasks (`TerrainData.maximumAsynchronousTasks = 5`). Beyond that, `scheduleTask` returns `undefined` and the caller retries next frame.
- **Worker wrapper:** [`createTaskProcessorWorker`][ce-tpw] wraps a function `(parameters, transferables) → result`. It serializes errors as name, message and stack, and it reports results that cannot be cloned.
- **Transfer probe:** the first task spawns an extra probe worker to check that `ArrayBuffer` transfer round-trips correctly (an old Firefox bug).
- **Copies and missing shared memory:**
  - [`GltfDracoLoader`][ce-draco] copies typed arrays before sending them, to avoid "already detached" errors.
  - [`TerrainPicker`][ce-pick] keeps picking on the main thread, because a vertex buffer can only be copied (slow) or transferred (lost to the main thread), and `SharedArrayBuffer` is rarely available.
- **Worker URLs:** built from `CESIUM_BASE_URL` + `Workers/` ([`buildModuleUrl`][ce-bmu]). Cross-origin URLs get a blob shim.
- **IIFE build:** inlines every worker into `Cesium.js` as a string and starts it from a blob URL ([PR #11519](https://github.com/CesiumGS/cesium/pull/11519)).
- **WebAssembly:** binaries are fetched on the main thread and transferred during `initWebAssemblyModule`.
- **Rendering:** on the main thread. OffscreenCanvas appears only as an image-source type.

**loaders.gl.**

- **Pools:** a `WorkerFarm` singleton keeps one [`WorkerPool`][lg-pool] per worker type. Each pool allows `maxConcurrency` 3 workers (1 on mobile, detected through `window.orientation`) and reuses idle workers. Jobs run in FIFO order with no priorities.
- **Transfer:** [`getTransferList`][lg-tl] walks the message recursively and moves every buffer it finds.
- **Cancellation:** aborting a job **terminates its worker** ([`worker-job.ts`][lg-job]), so the next job pays worker startup again.
- **Worker URLs:** the default is `https://unpkg.com/@loaders.gl/<module>@<version>/dist/<id>-worker.js` ([`get-worker-url.ts`][lg-url]). Any http(s) URL is wrapped in a blob that calls `importScripts` ([`get-loadable-worker-url.ts`][lg-blob]), which needs both `worker-src blob:` and a CDN `script-src`.
- **Overrides:** per-loader `workerUrl` options. Version 5.0 adds a `loadWorker` factory, so a bundler can see a literal `new Worker(new URL(...))`. Draco WebAssembly is referenced with `new URL(..., import.meta.url)`.

**deck.gl.**

- **No worker system of its own:** `MVTLayer`, `TerrainLayer` and the 3D tiles layers use loaders.gl's worker loaders ([`mvt-layer.ts`][dg-mvt], [`terrain-layer.ts`][dg-terr]) and expose `loadOptions.<loader>.workerUrl` and `worker: false`. The terrain layer documents that `workerUrl` is needed "if running offline and cannot access CDN".
- **Binary output:** MVT workers return binary attribute arrays that are used directly. This path is turned off in `GlobeView` (code comment: "GlobeView doesn't work well with binary data"). Worker output formats must be designed for the globe from the start.
- **Main-thread and GPU work:** attribute generation and aggregation.
- **OffscreenCanvas:** the multi-canvas mode `_canvases` ([`deck.ts`][dg-deck]) renders into an OffscreenCanvas **on the main thread**. Nothing renders in a worker.

**3DTilesRendererJS.**

- **Queues on the main thread** ([`TilesRendererBase.js`][tt-base]), each a [`PriorityQueue`][tt-pq] run from `requestAnimationFrame` through a [`Scheduler`][tt-sched] that can also follow an XR session's frame loop:
  - downloads, at most 25 per origin;
  - parsing, at most 5 jobs;
  - node processing, at most 25.
- **Where workers are used:** only inside three.js `DRACOLoader`, `KTX2Loader` and meshopt.
- **Images:** decoded with `createImageBitmap`. Terrain-RGB elevation is read on the main thread with an OffscreenCanvas 2D context ([`GridCache.js`][tt-grid]).
- **Maintainers' position:** no workers without timing evidence. They say most hitches come from GPU uploads ([#318](https://github.com/NASA-AMMOS/3DTilesRendererJS/issues/318)), and that bundlers and cross-origin CDNs block worker loading ([#489](https://github.com/NASA-AMMOS/3DTilesRendererJS/issues/489)).

**Potree.**

- **Pool:** [`WorkerPool.js`][po-pool] maps each worker URL to a free list and spawns a new worker whenever none is idle. The only bound is the global `Potree.maxNodesLoading = 4`.
- **Decoding:** [`OctreeLoader.js`][po-ol] fetches a byte range on the main thread and transfers it. The [decoder worker][po-dw] builds attribute arrays and density, and transfers them back.
- **Worker paths:** come from `Potree.scriptPath`, which is derived from `document.currentScript` or `import.meta.url`.
- **No error handling:** there is no `onerror` and no `terminate`, so a decoder exception leaves a node "loading" forever.

**OpenLayers.**

- **WebGL vector worker:** the WebGL vector renderer lazily creates **one** shared worker ([`VectorStyleRenderer.js`][ol-vsr]). The worker turns flat `Float32Array` render instructions into vertex and index buffers, including polygon triangulation ([`webgl.js`][ol-webgl]).
- **Buffer reuse:** buffers are transferred both ways, and the instruction buffer is returned for reuse.
- **Text worker:** a second worker ([`textOverlay.js`][ol-text]) draws labels with OffscreenCanvas 2D on its own `requestAnimationFrame` and returns `transferToImageBitmap()` results.
- **Worker loading:** [`serialize-workers.cjs`][ol-ser] inlines each worker as a string at build time and starts it from a Blob URL.
- **OffscreenCanvas map rendering:** an "experimental" example renders a whole vector-tile map in a worker ([`offscreen-canvas.js`][ol-off]). The worker frame always lags the main-thread view, so the example warps the older frame toward the current view with a CSS transform.

**three.js.**

- **Decoder workers:** `DRACOLoader` and `KTX2Loader` ([`DRACOLoader.js`][th-draco]) build their worker by concatenating the downloaded decoder script with `Function.prototype.toString()` of the worker body into a Blob URL.
- **Scheduling:** both have a `workerLimit` of 4. Draco assigns each task to the worker with the lowest summed task cost (byte length). KTX2 uses a FIFO [`WorkerPool`][th-pool]. Every loader keeps its own pool ([#18234](https://github.com/mrdoob/three.js/issues/18234)).
- **OffscreenCanvas:** both renderers accept an `OffscreenCanvas` ([`Renderer.js`][th-rend]). The `webgl_worker_offscreencanvas` example shows a worker-rendered scene that keeps animating while the main thread is busy.

| Project           | Topology                            | Default count         | Worker loading                           | Works without `blob:`  | Cancel               | Renders in a worker              |
| ----------------- | ----------------------------------- | --------------------- | ---------------------------------------- | ---------------------- | -------------------- | -------------------------------- |
| MapLibre          | shared stateful actors, round-robin | 1 (Safari ≤ 3)        | `import.meta.url` + override             | yes, if same-origin    | queued + cooperative | no                               |
| CesiumJS          | one worker per task type            | many (per processor)  | base URL; blob for cross-origin and IIFE | ESM build only         | none in flight       | no                               |
| loaders.gl        | pool per worker type                | 3 per type (1 mobile) | CDN by default, blob + `importScripts`   | only with `loadWorker` | terminate            | no                               |
| deck.gl           | delegates to loaders.gl             | 3 per loader          | as loaders.gl                            | as loaders.gl          | as loaders.gl        | no (main-thread OffscreenCanvas) |
| 3DTilesRendererJS | main thread with rAF queues         | —                     | three.js blob workers                    | no (Draco/KTX2)        | queue removal        | no                               |
| Potree            | free list per URL                   | unbounded             | script path                              | yes                    | none                 | no                               |
| OpenLayers        | one shared worker                   | 1                     | inlined string → blob                    | no                     | none                 | example only                     |

## 4. Measurements taken for this survey

These were measured in headless Chromium 141 in a 4-vCPU Linux container, on a page served with `default-src 'self'; worker-src 'self'` and module workers. Only the relative values are meaningful. M3 repeats the measurements on the reference devices in every browser.

| Measurement                                                                      | p50                | p95                 |
| -------------------------------------------------------------------------------- | ------------------ | ------------------- |
| Spawn a module worker (1 KiB script) until its first message                     | 12.1 ms            | 22.7 ms             |
| Spawn 4 in parallel (1 KiB)                                                      | 28.3 ms            | 32.6 ms             |
| Spawn a module worker (1 MiB script)                                             | 70.9 ms            | 123 ms              |
| Spawn 4 in parallel (1 MiB)                                                      | 177.7 ms           | 193.1 ms            |
| Empty `postMessage` round trip                                                   | 0.1 ms             | 0.2 ms              |
| 16 MiB `ArrayBuffer` round trip, transferred / cloned                            | 1.9 / 52.2 ms      | 7.7 / 61.8 ms       |
| 50,000 GeoJSON-like point objects: **blocking** `postMessage` call on the sender | 81 ms              | 113 ms              |
| The same coordinates as one transferred `Float64Array`: `postMessage` call       | < 0.1 ms           | 0.1 ms              |
| `createImageBitmap` in a worker, 256 px JPEG / PNG / WebP                        | 3.2 / 3.9 / 7.8 ms | 6.9 / 5.3 / 15.9 ms |

Worker startup cost grows with script size. Cloning an object graph blocks the sender synchronously, while transfers cost almost nothing. Image decoding takes several milliseconds per tile, so a handful of workers is enough to keep up with a flight.

## 5. Known failure modes from issue trackers

| Area        | Issue                                                                                                                                                                  | Symptom                                                                                                         | Root cause                                                                           | Lesson                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Startup     | [maplibre #8018](https://github.com/maplibre/maplibre-gl-js/issues/8018)                                                                                               | Map hangs silently when the worker script fails; `load` never fires                                             | Worker load errors were not observed                                                 | Startup handshake with a timeout, then a typed error event              |
| Startup     | [maplibre #8188](https://github.com/maplibre/maplibre-gl-js/issues/8188)                                                                                               | Vite builds without a correct worker URL give a blank map with a generic 404 or MIME error                      | `import.meta.url` does not reach the worker file in bundles                          | The error must name the URL and the fix                                 |
| Startup     | [maplibre #8621](https://github.com/maplibre/maplibre-gl-js/issues/8621)                                                                                               | Crash after an upgrade until the cache was cleared                                                              | Worker imported an unversioned shared chunk cached separately                        | One self-contained, versioned worker file and a build-id check          |
| Startup     | [potree #464](https://github.com/potree/potree/issues/464)                                                                                                             | Chrome crash and Firefox "too many workers" with 203 point clouds                                               | Load limit counted per cloud; about 20 concurrent workers                            | One global worker cap for all instances and sources                     |
| Startup     | [cesium #11161](https://github.com/CesiumGS/cesium/issues/11161)                                                                                                       | Parallelism needs more processor objects                                                                        | One worker per task type                                                             | A generic shared pool: parallelism independent of task type             |
| Lifecycle   | [openlayers #16436](https://github.com/openlayers/openlayers/issues/16436)                                                                                             | `Worker is not defined` on import (Jest, Next.js)                                                               | Worker created at module load; fixed by lazy creation                                | Create workers only at runtime (SSR)                                    |
| Lifecycle   | [openlayers #16276](https://github.com/openlayers/openlayers/issues/16276)                                                                                             | OffscreenCanvas example worker grew to 1.5 GB                                                                   | Worker-side cleanup never ran                                                        | Stateless workers; soak-test worker memory                              |
| Lifecycle   | [deck.gl #7299](https://github.com/visgl/deck.gl/issues/7299), [openlayers #15209](https://github.com/openlayers/openlayers/issues/15209)                              | No tiles in Electron or sandboxes without workers                                                               | No main-thread path                                                                  | Degraded inline executor with a warning                                 |
| Throughput  | [openlayers #16987](https://github.com/openlayers/openlayers/issues/16987)                                                                                             | 847 features took 5.4 s in the worker                                                                           | One serial worker, `Math.acos` and `push`-heavy buffer building                      | Pool, preallocated outputs; worker time is latency                      |
| Throughput  | [cesium #13556](https://github.com/CesiumGS/cesium/issues/13556)                                                                                                       | Multi-second stalls on large MVT layers                                                                         | Decode and mesh on the main thread; burst arrival; intermediate glTF                 | Workers **and** a per-frame budget for applying results                 |
| Throughput  | [3DTilesRendererJS #318](https://github.com/NASA-AMMOS/3DTilesRendererJS/issues/318)                                                                                   | Load hitches                                                                                                    | Mostly GPU uploads, which workers cannot take                                        | Upload budget is separate from workers                                  |
| Throughput  | [3DTilesRendererJS #489](https://github.com/NASA-AMMOS/3DTilesRendererJS/issues/489)                                                                                   | Hitches when loading 3 MB tiles                                                                                 | `fetch` + `arrayBuffer()` on the main thread (unexplained); closed as not worthwhile | Measure main-thread network cost per tile                               |
| Transfer    | [maplibre #6667](https://github.com/maplibre/maplibre-gl-js/issues/6667)                                                                                               | Every GeoJSON diff returned the whole dataset                                                                   | Worker result included all data for `getStyle()`                                     | Never round-trip large structured data                                  |
| Transfer    | [openlayers #17343](https://github.com/openlayers/openlayers/issues/17343)                                                                                             | UI frozen while about 11 workers decoded COGs                                                                   | geotiff.js regression (transfer suspected)                                           | Benchmarks must assert main-thread time with workers active             |
| Transfer    | [cesium #10502](https://github.com/CesiumGS/cesium/issues/10502)                                                                                                       | `SharedArrayBuffer` undefined in workers                                                                        | Needs cross-origin isolation (COOP/COEP)                                             | Cannot rely on shared memory with arbitrary tile hosts                  |
| Transfer    | [loaders.gl #3962](https://github.com/visgl/loaders.gl/issues/3962)                                                                                                    | WKB worker fails from unpkg and returns `null` via Vite `?url`                                                  | CDN default; transfer can outweigh work for small inputs                             | No CDN defaults; tiny inputs need no worker                             |
| Correctness | [maplibre #3110](https://github.com/maplibre/maplibre-gl-js/issues/3110)                                                                                               | Terrain off by hundreds of meters in Safari private mode                                                        | Anti-fingerprinting noise in `getImageData`                                          | Pixel-exact decode path with a probe                                    |
| CSP         | [cesium #9024](https://github.com/CesiumGS/cesium/issues/9024)                                                                                                         | Workers needed `unsafe-eval`                                                                                    | RequireJS bootstrapper `eval`; fixed by ESM workers (2023)                           | Module workers, no loader shims                                         |
| CSP         | [cesium #13617](https://github.com/CesiumGS/cesium/issues/13617), [#13412](https://github.com/CesiumGS/cesium/issues/13412)                                            | `EvalError` under strict CSP                                                                                    | WebAssembly compiled on the main thread; Emscripten glue uses `new Function`         | WebAssembly only in workers; build with `DYNAMIC_EXECUTION=0`           |
| CSP         | [three.js #34389](https://github.com/mrdoob/three.js/issues/34389)                                                                                                     | KTX2 transcoding fails without `unsafe-eval`                                                                    | embind invokers built with `new Function`; rebuild works (UASTC about 8% slower)     | Ship decoders built without dynamic execution                           |
| CSP         | [openlayers #17630](https://github.com/openlayers/openlayers/issues/17630)                                                                                             | WebGL worker blocked without `worker-src blob:`                                                                 | Worker inlined as a string                                                           | Real worker files only                                                  |
| CSP         | [maplibre #3613](https://github.com/maplibre/maplibre-gl-js/issues/3613)                                                                                               | No source maps or stable breakpoints in the worker                                                              | Blob-URL worker                                                                      | Real files also fix debugging                                           |
| Bundler     | [maplibre #7339](https://github.com/maplibre/maplibre-gl-js/issues/7339), [#7105](https://github.com/maplibre/maplibre-gl-js/issues/7105)                              | Worker code broken only in production (Vite 8, Next.js): `Ia is not defined`, `_define_property is not defined` | App bundler re-processed worker code (tree-shaking, helpers)                         | Prebuilt self-contained worker; a test that loads it standalone         |
| Bundler     | [cesium #8327](https://github.com/CesiumGS/cesium/issues/8327)                                                                                                         | 404s for workers and assets when imported as a module                                                           | Base URL could not be detected; assets copied manually                               | The default must be bundler-detected; base URL only as an override      |
| Bundler     | [loaders.gl #2014](https://github.com/visgl/loaders.gl/issues/2014), [deck.gl #8039](https://github.com/visgl/deck.gl/issues/8039)                                     | Workers fetched from the CDN; compressed glTF fails offline                                                     | Version not injected, so it fell back to `latest` on unpkg                           | No network fallback for code                                            |
| Bundler     | [deck.gl #9987](https://github.com/visgl/deck.gl/issues/9987)                                                                                                          | `workerUrl: null` silently used the CDN in render tests                                                         | Implicit fallback                                                                    | Explicit, typed switches                                                |
| Bundler     | [three.js #26403](https://github.com/mrdoob/three.js/issues/26403), [potree #370](https://github.com/potree/potree/issues/370)                                         | Decoder and worker files missing from bundles                                                                   | Folder paths and plugins that bundlers cannot trace                                  | Literal `new URL('./file', import.meta.url)` per file                   |
| Bundler     | [vite #8427](https://github.com/vitejs/vite/issues/8427), [#20859](https://github.com/vitejs/vite/issues/20859), [#23785](https://github.com/vitejs/vite/issues/23785) | Worker URLs inside pre-bundled dependencies point to missing files in dev; the SPA fallback returns HTML        | Dependency optimizer moves modules; Vite 8 rebases non-relative specifiers           | Relative `./` URLs; document `optimizeDeps.exclude`; test dev and build |

## 6. How they test and benchmark worker code

- **MapLibre:**
  - Vitest unit tests construct the worker-side `Worker` class in-process with a fake `self` and mocked actors.
  - [`web_worker.test.ts`][ml-wwt] stubs the `Worker` constructor to check URL and module-or-classic selection.
  - Build tests ([`esm.test.ts`][ml-esm]) check that the worker bundle exists, targets ES2022, loads standalone as an ES module and has source maps.
  - Micro-benchmarks (`worker_tile.bench.ts`, Vitest bench) parse fixture tiles in-process.
  - End-to-end benchmarks load the built `dist` in headless Chrome against local fixtures and time import, style load, first tile and first idle against a published release.
  - Worker count was set by production A/B tests.
- **CesiumJS:**
  - Jasmine/Karma specs run in real browsers with real workers.
  - Test workers are built separately with esbuild (`Specs/TestWorkers` in [`scripts/build.js`][ce-build]).
  - [`TaskProcessorSpec`][ce-spec] covers cross-origin shims, transfers in both directions, thrown errors and results that cannot be cloned.
  - The worker functions are covered only through higher-level terrain and model specs. There is no worker benchmark.
- **loaders.gl:**
  - Vitest specs run in browsers and in Node (`worker_threads`).
  - [Pool specs][lg-spec] start inline-source workers to check concurrency, reuse and destruction.
  - URL resolution and message boundaries have their own specs.
  - probe.gl benchmarks ([`draco.bench.ts`][lg-bench]) **warm the worker first** so that startup is excluded, then report throughput (points/s), sequential vs parallel.
- **deck.gl:**
  - Render tests force `worker: false` for deterministic main-thread parsing ([#9987](https://github.com/visgl/deck.gl/issues/9987)).
  - probe.gl benchmarks cover main-thread work only (tessellation, attribute updates).
- **3DTilesRendererJS:** Vitest tests of the rAF-driven `PriorityQueue` and `Scheduler`. It has no workers to test, and maintainers ask for timing data before adding any.
- **Potree:** no automated tests or benchmarks in the repository.
- **OpenLayers:**
  - Vitest browser tests spawn the **real** serialized worker through a Vite plugin ([`vite-plugin-ol-worker.mjs`][ol-plugin]) that reuses the production serializer.
  - They post messages and assert the returned buffers ([`webgl.test.js`][ol-test]).
  - Rendering tests compare screenshots.
- **three.js:** no automated worker tests; examples only.

Overall, nobody benchmarks the main-thread cost of streaming with workers active, worker startup, or the effect of worker count on frame time. VibeGlobe adds these as tracked benchmarks (section 9).

## 7. Literature

- **Cozzi and Ring, 3D Engine Design for Virtual Globes (2011), chapter "Exploiting Parallelism in Resource Preparation":** preparation (I/O, decoding, tessellation) runs on worker threads fed by message queues, and the rendering thread keeps only what must touch the GPU. That is the split used here. The book's option of a second GL context for off-thread uploads has no web equivalent unless rendering itself moves to a worker.
- **Agafonkin, MARTINI (2019):** RTIN mesh generation from a heightmap is fast and self-contained, so it suits a worker task in M4.
- **Specifications:**
  - HTML Living Standard: workers, structured clone and transfer.
  - CSP Level 3: a worker loaded from a URL gets the policy delivered with its own response, while `blob:` and `data:` workers inherit the creator's policy. This is what lets `wasm-unsafe-eval` be scoped to worker files ([cesium #13617](https://github.com/CesiumGS/cesium/issues/13617)).
  - WebGPU: `navigator.gpu` in dedicated workers.
- **Surma, "Is postMessage slow?" (2019):** the cost is dominated by structured cloning of large object graphs. Our measurements in section 4 agree.

## 8. Comparison of approaches

- **Topology:**
  - **Per-type workers** (Cesium, loaders.gl, three.js) are simple to write, but the worker count grows with every feature: Potree reached a crash and Cesium runs many workers in a varied scene. Idle workers of one type cannot help another.
  - **Shared stateful actors** (MapLibre) keep the count bounded, but worker-side state causes leaks (MapLibre's changelog lists worker leaks on map removal and on aborted tiles). Round-robin ignores priorities, and every worker repeats the initialization (style parsing).
  - **A shared stateless pool with a central priority queue** keeps the count bounded and priorities global. Cancelling a queued task is free, a crashed worker is replaced without losing state, and per-worker initialization is only loading code.
  - **Main thread with rAF queues** (3DTilesRendererJS) is the simplest option, but it cannot keep decoding of heavy JPEG/WebP, terrain meshing or MVT tessellation under the 6 ms main-thread budget on tablets.
- **Loading:**
  - Inlined strings or blobs (OpenLayers, three.js, Cesium IIFE) and CDN defaults (loaders.gl) fail strict CSP, offline mode or the privacy rule.
  - A manual base URL (Cesium, Potree) works but makes every consumer copy assets.
  - A literal `new Worker(new URL('./w.js', import.meta.url), { type: 'module' })` is detected by Vite (in production builds, and in dev subject to the pre-bundling caveats), webpack 5 and Parcel. The Vite docs require the `new URL()` to sit directly inside `new Worker()` with static options. With a configured-URL override, this is the only approach that satisfies every requirement.
  - `new Worker()` refuses cross-origin URLs, and working around that needs a blob shim, which means `worker-src blob:`.
- **Transfer:**
  - Structured cloning of object graphs blocks the sender: 81 ms for 50,000 features.
  - Transferring flat typed arrays and `ImageBitmap`s is effectively free.
  - `SharedArrayBuffer` needs cross-origin isolation, which forces every tile host to send CORP or CORS headers. That is unacceptable for a map-agnostic engine embedded in apps that do not control headers.
- **Cancellation:**
  - Removing a task from a main-thread queue costs nothing.
  - Cooperative cancellation of a running task is cheap.
  - Terminating a worker (loaders.gl) costs 12–70 ms of startup per cancelled tile, which matters during flights.
- **WebAssembly:**
  - Compiling WebAssembly needs `'wasm-unsafe-eval'` (Chrome 97, Firefox 102, Safari 16), and Emscripten embind glue additionally needs `unsafe-eval` unless built with `DYNAMIC_EXECUTION=0`.
  - Keeping WebAssembly in workers that load from real URLs lets the page CSP stay strict.
- **Rendering from a worker:**
  - **Support:** WebGL2 in OffscreenCanvas is available in Chrome 69, Firefox 105 and Safari 17. WebGPU in workers is available wherever WebGPU is (Chrome 113, Linux from 144; Firefox 141 on Windows; Safari 26), and the three.js renderers accept an OffscreenCanvas. So both backends could run in a worker across the browser matrix.
  - **Gain:** host-application jank (Vue re-renders, the app's own work) no longer stalls frames.
  - **Input:** events arrive on the main thread and must be forwarded.
  - **DOM overlays:** attribution, markers, popups and the Vue/UI controls are positioned from main-thread camera state that is a message behind the worker frame. OpenLayers hides this with a CSS warp of the older frame, which is only correct for 2D affine views and cannot be done for a perspective globe.
  - **Public API:** the synchronous API (camera snapshots, `project`/`unproject`, picking) would have to become asynchronous or be mirrored.
  - **Loss recovery and debugging:** device-loss recovery and debugging move into the worker.
  - **Adoption:** no studied engine renders from a worker in production.

## 9. Chosen approach and what must be measured

Recorded in [ADR 0011](../adr/0011-workers.md). In short:

- **Pool:** one page-wide pool of generic, stateless **module workers**, shared by all engine instances (keyed by worker URL) and reference-counted.
  - It starts with one worker when the first globe is created and grows on backlog up to `clamp(hardwareConcurrency − 2, 1, 4)`.
  - A central priority queue on the main thread, fed by the scheduler, keeps one task in flight per worker.
  - Queued tasks are cancelled by removal; running tasks are cancelled cooperatively between stages. Workers are terminated only by the watchdog or by the last `destroy()`.
- **Inputs and outputs:** inputs are transferred `ArrayBuffer`s fetched by the main-thread scheduler. Outputs are `ImageBitmap`s or flat typed arrays plus small metadata. There is no class serialization and no `SharedArrayBuffer`.
- **Loading:**
  - The worker program is one prebuilt, self-contained, versioned file loaded through a literal `new Worker(new URL('./vibeglobe-worker.js', import.meta.url), { type: 'module' })`.
  - `assets.workerUrl` and `assets.wasmBaseUrl` override it and must be same-origin.
  - There is no `blob:`, `data:`, `eval` or `new Function` anywhere, and no CDN fallback.
  - A startup handshake checks the build id, with a timeout and typed error events.
- **WebAssembly:** only in workers, fetched by the worker, built without dynamic execution, with a JS fallback or a typed "unsupported" error.
- **Rendering:** stays on the main thread. The renderer and core stay DOM-free, so the M2 OffscreenCanvas experiment can host them in a worker and decide by measurement.

**M2 (F065), OffscreenCanvas experiment.**

- **Setup:** a playground variant renders in a worker (canvas transferred with `transferControlToOffscreen`, input forwarded) on both backends in Chrome, Edge, Firefox and Safari.
- **Measurements:**
  - p95 frame interval with and without synthetic main-thread load (a 30 ms task every 100 ms);
  - input-to-frame latency (event timestamp to the presented frame that reflects it);
  - DOM overlay misalignment, in pixels, in recorded frames.
- **Adoption criteria:** adopt only if all of the following hold:
  - p95 under load improves by at least 25%;
  - p95 without load is no more than 5% worse;
  - the added latency is at most 4 ms p95;
  - overlay misalignment is 0 px.

**M3 (F099, F100), worker pool.**

- **Startup:** spawn-to-ready p50/p95 of the real worker program on each reference device and browser (budget ≤ 50 ms p95 on the reference desktop; worker program ≤ 100 KB min+gzip, excluding lazily loaded WebAssembly).
- **Throughput versus frame time:** decode throughput (tiles/s) for 256 and 512 px JPEG, PNG and WebP, and p95 frame time during a scripted flight, for pool sizes 1–6. This sets the default cap.
- **Main-thread cost:** long tasks over 50 ms attributable to the engine during heavy streaming must be 0 (PerformanceObserver), and the main-thread cost per received tile must stay ≤ 0.3 ms, excluding GPU upload.
- **Decoding location:** performance marks prove decoding happens on worker threads.
- **Cancellation waste:** decoded-but-discarded tiles during flights must stay below 5% of decodes.
- **CSP:** a strict-CSP run (`worker-src` limited to the asset origin, no `blob:`), plus a search of the built bundles for `eval`, `new Function` and blob-generated code, and a run with a different asset base URL.
- **Bundlers:** Vite dev and build in the playground, and `nuxt dev`/`nuxt build` in the Nuxt example, including a non-root base path.
- **Soak:** worker count and worker heap stay flat (worker heap measured through CDP in Chromium).

## 10. Open questions

1. **Fetching location:** should network fetch move into workers (as in MapLibre) if the M3 measurement shows main-thread `fetch` + `arrayBuffer()` costs above 0.3 ms per tile? The task protocol allows a fetch-and-decode task later.
2. **Persistent cache writes:** should they happen inside workers to avoid structured-cloning bytes into IndexedDB on the main thread? Decided in the offline survey (M8).
3. **Buffer recycling:** should typed arrays be returned to workers after upload? Add it only if heap profiling shows garbage-collection pauses above 1 ms from tile buffers.
4. **Pixel-exact DEM decoding:** OffscreenCanvas readback with a distortion probe, `VideoFrame.copyTo`, or a JS PNG decoder over `DecompressionStream`? Decided in the terrain survey (M4).
5. **Shared memory:** should `SharedArrayBuffer` be an optional fast path when `crossOriginIsolated` is true (for example for terrain height queries)? Not before a measured need.
6. **Cross-origin worker hosting:** a CDN would need a blob shim, which the CSP rule forbids. Confirm that consuming applications can serve assets from the page origin.

[ml]: https://github.com/maplibre/maplibre-gl-js/tree/95c703172ab9d745eb809672006f68775cef7400
[ml-pool]: https://github.com/maplibre/maplibre-gl-js/blob/95c703172ab9d745eb809672006f68775cef7400/src/util/worker_pool.ts
[ml-disp]: https://github.com/maplibre/maplibre-gl-js/blob/95c703172ab9d745eb809672006f68775cef7400/src/util/dispatcher.ts
[ml-ajax]: https://github.com/maplibre/maplibre-gl-js/blob/95c703172ab9d745eb809672006f68775cef7400/src/util/ajax.ts
[ml-ocd]: https://github.com/maplibre/maplibre-gl-js/blob/95c703172ab9d745eb809672006f68775cef7400/src/util/offscreen_canvas_distorted.ts
[ml-ser]: https://github.com/maplibre/maplibre-gl-js/blob/95c703172ab9d745eb809672006f68775cef7400/src/util/web_worker_transfer.ts
[ml-ti]: https://github.com/maplibre/maplibre-gl-js/blob/95c703172ab9d745eb809672006f68775cef7400/src/util/throttled_invoker.ts
[ml-ww]: https://github.com/maplibre/maplibre-gl-js/blob/95c703172ab9d745eb809672006f68775cef7400/src/util/web_worker.ts
[ml-build]: https://github.com/maplibre/maplibre-gl-js/blob/95c703172ab9d745eb809672006f68775cef7400/rolldown.config.ts
[ml-wwt]: https://github.com/maplibre/maplibre-gl-js/blob/95c703172ab9d745eb809672006f68775cef7400/src/util/web_worker.test.ts
[ml-esm]: https://github.com/maplibre/maplibre-gl-js/blob/95c703172ab9d745eb809672006f68775cef7400/test/build/esm.test.ts
[ce]: https://github.com/CesiumGS/cesium/tree/621826db344eb7f1248f6bd50ed4770563127f12
[ce-tp]: https://github.com/CesiumGS/cesium/blob/621826db344eb7f1248f6bd50ed4770563127f12/packages/engine/Source/Core/TaskProcessor.js
[ce-tpw]: https://github.com/CesiumGS/cesium/blob/621826db344eb7f1248f6bd50ed4770563127f12/packages/engine/Source/Workers/createTaskProcessorWorker.js
[ce-draco]: https://github.com/CesiumGS/cesium/blob/621826db344eb7f1248f6bd50ed4770563127f12/packages/engine/Source/Scene/GltfDracoLoader.js
[ce-pick]: https://github.com/CesiumGS/cesium/blob/621826db344eb7f1248f6bd50ed4770563127f12/packages/engine/Source/Core/TerrainPicker.js
[ce-bmu]: https://github.com/CesiumGS/cesium/blob/621826db344eb7f1248f6bd50ed4770563127f12/packages/engine/Source/Core/buildModuleUrl.js
[ce-build]: https://github.com/CesiumGS/cesium/blob/621826db344eb7f1248f6bd50ed4770563127f12/scripts/build.js
[ce-spec]: https://github.com/CesiumGS/cesium/blob/621826db344eb7f1248f6bd50ed4770563127f12/packages/engine/Specs/Core/TaskProcessorSpec.js
[lg]: https://github.com/visgl/loaders.gl/tree/a6120f5c1085bc3b6c0f445c49945b22a9249c03
[lg-pool]: https://github.com/visgl/loaders.gl/blob/a6120f5c1085bc3b6c0f445c49945b22a9249c03/modules/core/src/worker-utils/lib/worker-farm/worker-pool.ts
[lg-tl]: https://github.com/visgl/loaders.gl/blob/a6120f5c1085bc3b6c0f445c49945b22a9249c03/modules/core/src/worker-utils/lib/worker-utils/get-transfer-list.ts
[lg-job]: https://github.com/visgl/loaders.gl/blob/a6120f5c1085bc3b6c0f445c49945b22a9249c03/modules/core/src/worker-utils/lib/worker-farm/worker-job.ts
[lg-url]: https://github.com/visgl/loaders.gl/blob/a6120f5c1085bc3b6c0f445c49945b22a9249c03/modules/core/src/worker-utils/lib/worker-api/get-worker-url.ts
[lg-blob]: https://github.com/visgl/loaders.gl/blob/a6120f5c1085bc3b6c0f445c49945b22a9249c03/modules/core/src/worker-utils/lib/worker-utils/get-loadable-worker-url.ts
[lg-spec]: https://github.com/visgl/loaders.gl/blob/a6120f5c1085bc3b6c0f445c49945b22a9249c03/modules/core/test/worker-utils-package/lib/worker-farm/worker-pool.spec.ts
[lg-bench]: https://github.com/visgl/loaders.gl/blob/a6120f5c1085bc3b6c0f445c49945b22a9249c03/modules/draco/test/draco.bench.ts
[dg]: https://github.com/visgl/deck.gl/tree/cb353ad57f45e0f59eb29e9d0973d43868f977fd
[dg-mvt]: https://github.com/visgl/deck.gl/blob/cb353ad57f45e0f59eb29e9d0973d43868f977fd/modules/geo-layers/src/mvt-layer/mvt-layer.ts
[dg-terr]: https://github.com/visgl/deck.gl/blob/cb353ad57f45e0f59eb29e9d0973d43868f977fd/modules/geo-layers/src/terrain-layer/terrain-layer.ts
[dg-deck]: https://github.com/visgl/deck.gl/blob/cb353ad57f45e0f59eb29e9d0973d43868f977fd/modules/core/src/lib/deck.ts
[tt]: https://github.com/NASA-AMMOS/3DTilesRendererJS/tree/3febfcff2869771a9152084b80312ae5e244133e
[tt-base]: https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/3febfcff2869771a9152084b80312ae5e244133e/src/core/renderer/tiles/TilesRendererBase.js
[tt-pq]: https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/3febfcff2869771a9152084b80312ae5e244133e/src/core/renderer/utilities/PriorityQueue.js
[tt-sched]: https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/3febfcff2869771a9152084b80312ae5e244133e/src/core/renderer/utilities/Scheduler.js
[tt-grid]: https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/3febfcff2869771a9152084b80312ae5e244133e/src/three/plugins/images/terrain-rgb/GridCache.js
[po]: https://github.com/potree/potree/tree/5636cd471d9eb464969e758be45c44d7613d3859
[po-pool]: https://github.com/potree/potree/blob/5636cd471d9eb464969e758be45c44d7613d3859/src/WorkerPool.js
[po-ol]: https://github.com/potree/potree/blob/5636cd471d9eb464969e758be45c44d7613d3859/src/modules/loader/2.0/OctreeLoader.js
[po-dw]: https://github.com/potree/potree/blob/5636cd471d9eb464969e758be45c44d7613d3859/src/modules/loader/2.0/DecoderWorker.js
[ol]: https://github.com/openlayers/openlayers/tree/60b34fc2f6c90eec84e4995dd101f610a657187a
[ol-vsr]: https://github.com/openlayers/openlayers/blob/60b34fc2f6c90eec84e4995dd101f610a657187a/src/ol/render/webgl/VectorStyleRenderer.js
[ol-webgl]: https://github.com/openlayers/openlayers/blob/60b34fc2f6c90eec84e4995dd101f610a657187a/src/ol/worker/webgl.js
[ol-text]: https://github.com/openlayers/openlayers/blob/60b34fc2f6c90eec84e4995dd101f610a657187a/src/ol/worker/textOverlay.js
[ol-ser]: https://github.com/openlayers/openlayers/blob/60b34fc2f6c90eec84e4995dd101f610a657187a/tasks/serialize-workers.cjs
[ol-off]: https://github.com/openlayers/openlayers/blob/60b34fc2f6c90eec84e4995dd101f610a657187a/examples/offscreen-canvas.js
[ol-plugin]: https://github.com/openlayers/openlayers/blob/60b34fc2f6c90eec84e4995dd101f610a657187a/test/browser/vite-plugin-ol-worker.mjs
[ol-test]: https://github.com/openlayers/openlayers/blob/60b34fc2f6c90eec84e4995dd101f610a657187a/test/browser/spec/ol/worker/webgl.test.js
[th]: https://github.com/mrdoob/three.js/tree/f480849e035f339b80c58f970fcb5e755abaa549
[th-draco]: https://github.com/mrdoob/three.js/blob/f480849e035f339b80c58f970fcb5e755abaa549/examples/jsm/loaders/DRACOLoader.js
[th-pool]: https://github.com/mrdoob/three.js/blob/f480849e035f339b80c58f970fcb5e755abaa549/examples/jsm/utils/WorkerPool.js
[th-rend]: https://github.com/mrdoob/three.js/blob/f480849e035f339b80c58f970fcb5e755abaa549/src/renderers/common/Renderer.js
[vi]: https://github.com/vitejs/vite/blob/2601eed4d764f21809652dbba745d0f38b47146c/docs/guide/features.md
