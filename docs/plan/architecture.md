# Architecture

The engine is a framework-agnostic TypeScript core that owns all globe logic (geodesy, camera, view modes, tiling, scheduling, caching policy), with the renderer, input handling, sources, data layers, offline storage and UI attached as plug-ins through interfaces the core defines. Framework adapters (Vue 3, Web Component) wire the plug-ins together for consumers.

## 1. Packages

npm workspaces monorepo ([ADR 0002](../adr/0002-monorepo-and-tooling.md)). All publishable packages use the `@vibeglobe/` scope (see [open questions](../open-questions.md) on the registry scope).

| Package                    | Path                           | Responsibility                                                                                                                                                                                                                                                                                                                                                                                 | Depends on                               |
| -------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `@vibeglobe/core`          | `packages/core`                | Math (float64 vectors and matrices, pooled), WGS84 geodesy, projections and the globe-to-flat morph, camera model, view modes (chosen vs applied), animations, tiling schemes and quadtree, level-of-detail selection, request scheduler, memory cache and residency, loading policy (network mode, switches, provider profiles), events, the `createGlobe` facade and every plug-in interface | nothing at runtime                       |
| `@vibeglobe/renderer`      | `packages/renderer`            | `RendererBackend` implementation on three.js `WebGPURenderer` (WebGPU, automatic WebGL2 fallback), TSL shaders, GPU resource management, upload budget, picking buffer, device/context loss recovery                                                                                                                                                                                           | core, three (pinned)                     |
| `@vibeglobe/sources`       | `packages/sources`             | Source adapters (XYZ/TMS, WMTS, WMS, PMTiles, MBTiles, georeferenced image, quantized-mesh, Terrarium, Terrain-RGB, GeoJSON, KML, GPX, MVT, glTF, 3D Tiles), decoders that run in workers, reprojection, provider profiles (Google, OpenStreetMap)                                                                                                                                             | core                                     |
| `@vibeglobe/layers`        | `packages/layers`              | Data primitives, clustering, labels (SDF), styling expressions (MapLibre Style Specification semantics), picking and feature events, draping and ground clamping, vector-tile and building rendering                                                                                                                                                                                           | core, renderer                           |
| `@vibeglobe/controls`      | `packages/controls`            | Pointer, wheel, touch and keyboard input; gesture recognizers; inertia; navigation logic that drives the core camera API                                                                                                                                                                                                                                                                       | core                                     |
| `@vibeglobe/offline`       | `packages/offline`             | Persistent cache stores (IndexedDB / OPFS), offline package reader and installer, package management API, connectivity monitor, bandwidth estimator, in-browser package downloads                                                                                                                                                                                                              | core, sources                            |
| `@vibeglobe/ui`            | `packages/ui`                  | Optional ready-made DOM controls (vanilla TypeScript + CSS variables), theming, English and Italian, accessibility                                                                                                                                                                                                                                                                             | core                                     |
| `@vibeglobe/vue`           | `packages/vue`                 | Vue 3 components and composables, SSR-safe                                                                                                                                                                                                                                                                                                                                                     | core, renderer, controls, ui (peer: vue) |
| `@vibeglobe/web-component` | `packages/web-component`       | `<vibe-globe>` custom element, registered only by an explicit call                                                                                                                                                                                                                                                                                                                             | core, renderer, controls, ui             |
| `@vibeglobe/tools`         | `packages/tools`               | Node CLI: dataset pipeline, offline package builder, license audit and notices                                                                                                                                                                                                                                                                                                                 | core, sources, offline                   |
| playground                 | `apps/playground`              | Demo app exercising every feature; bed for visual, scenario and performance tests                                                                                                                                                                                                                                                                                                              | everything                               |
| docs site                  | `typedoc.json`, `docs/guides/` | Documentation site (TypeDoc) with the guides and the API reference generated from the types, built to `docs-site/`                                                                                                                                                                                                                                                                             | —                                        |
| Nuxt example               | `apps/nuxt-example`            | SSR integration test bed for the Vue adapter                                                                                                                                                                                                                                                                                                                                                   | vue                                      |

Dependency rules (checked in CI from M1):

- No package depends on Vue, Nuxt, React or Cube, except `@vibeglobe/vue` on Vue. Nothing anywhere refers to Cube.
- `core` has no runtime dependencies and compiles without the DOM library, so nothing in it can touch `window`, `document` or the GPU at import time. Browser APIs are reached only through plug-ins created by the application at runtime.
- three.js is imported only inside `renderer` (and `layers` through the renderer's exported helpers). Swapping the backend never touches globe logic.
- Every package is ESM, `sideEffects: false`, with no top-level side effects: importing it under SSR is always safe (tested for every package).
- Third-party runtime dependencies need a permissive license and an ADR; the license audit enforces the allow-list.

## 2. Runtime model

`createGlobe(options)` builds one engine instance bound to a container element. Several instances can live on one page; they share nothing but the worker pool and the persistent cache store, both reference-counted.

The frame loop runs on `requestAnimationFrame` only while something changes (render on demand). Each frame:

1. **Clock:** time step from the rAF timestamp, clamped so a long pause never produces a jump.
2. **Input:** controls apply pending gestures to camera targets; inertia decays by elapsed time.
3. **Animation:** active `flyTo`/`easeTo`/tour advance by elapsed time; any user input cancels them, starting from the applied camera so nothing jumps.
4. **View resolution:** zoom drives the morph factor, tilt curve and relief scale (Auto mode) or the user's chosen values (2D locked, manual); constraints and terrain collision produce the applied values without touching the chosen ones.
5. **Camera:** float64 view and projection matrices, eye position split into high/low float32 parts, frustum planes, horizon-culling occluder.
6. **Selection:** terrain and imagery layers each traverse their quadtree by screen-space error with frustum and horizon culling, producing a render set with ancestor fallback and a list of wanted tiles with priorities.
7. **Loading:** the scheduler dispatches wanted tiles through policy, cache hierarchy, network and workers; stale requests are cancelled.
8. **Residency:** decoded tiles enter the upload queue, drained within the per-frame time and byte budget; LRU eviction keeps GPU and RAM within budget, never evicting the pinned base or anything on screen.
9. **Layers:** data layers update batches, clustering and label placement (heavy work in workers, results applied here).
10. **Draw:** the renderer draws the frame description: state-sorted batches, cross-fade alphas, overlays.
11. **Idle check:** if anything moves, animates, fades or is loading, request the next frame; otherwise stop and emit `idle`. Hidden tabs stop rendering; background work is throttled.

The hot path (steps 1–11) allocates nothing in steady state: math types are preallocated `Float64Array`s, per-frame lists are reused arrays with explicit lengths, and tile records come from pools. Hot-path modules live in clearly marked files (`*.hot.ts`) with a header naming the benchmark that justifies them.

## 3. Coordinate systems and precision

**Decided:** WGS84 for every position, measurement and computation ([PLAN.md Fixed constraints](../../PLAN.md)).

| Space                                                                                                                 | Use                                                         |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Geodetic (longitude, latitude in radians internally, degrees in the public API; height in meters above the ellipsoid) | Public API, sources, measurements                           |
| ECEF (meters, float64)                                                                                                | Globe geometry, camera, culling                             |
| ENU (local east-north-up at a point)                                                                                  | Camera orientation (heading, tilt), models, ground clamping |
| Flat map space (Web Mercator meters, float64)                                                                         | The flat phase; the morph target                            |
| Tile-local (float32, relative to tile center)                                                                         | Vertex buffers                                              |

**Proposed precision strategy (confirm in the precision survey, ADR in M2):** all CPU math in float64. Tile vertices are stored relative to the tile center (RTC) in float32; per tile the CPU computes the model-view matrix in float64 relative to the eye and casts it to float32 only at the end, so the GPU never sees large magnitudes. Long primitives that cannot be split by tile (data-layer lines, large polygons) use relative-to-eye rendering with positions split into high and low float32 parts. Morph vertices carry both the globe and the flat position relative to the same center. Acceptance: no vertex jitter at 1 m altitude anywhere on Earth on both backends (scenario test with sub-millimeter camera moves, screen-space variance below 0.5 px).

## 4. Depth

**Proposed (confirm in the depth survey, ADR in M2):** reversed-Z with a 32-bit float depth buffer where available (native on WebGPU; on WebGL2 through clip-control extensions where exposed), tight near/far planes fitted each frame from camera height, terrain bounds and horizon distance, and a logarithmic-depth fallback where reversed-Z is unavailable. Multi-frustum rendering is the escape hatch if measurements show either approach failing. Acceptance: no z-fighting between near terrain, data layers and far geometry from orbit to 1 m altitude on both backends.

## 5. Globe, flat map and oblique view

One continuous camera; the shape morphs, nothing switches.

- **Morph:** vertices hold globe (ECEF, RTC) and flat (Web Mercator, RTC) positions; the vertex shader mixes them by the morph factor `m(zoom)` (eased, no thresholds). Normals and the camera up vector follow the same mix.
- **Anchor:** while `m` changes, the camera is re-solved each frame so the geographic point under the cursor (or the screen center) maps to the same screen pixel: the anchor is unprojected before the morph step and the camera translated in morph space after it.
- **Curves:** tilt and relief scale are eased functions of zoom with slight overlap (tilt starts as flattening ends). Values are tuning constants in one module, covered by continuity tests (no derivative jumps).
- **Relief on the flat plane:** heights are scaled by the Mercator scale factor at the anchor latitude so relief stays consistent with the plane; measurements always use the ellipsoid.
- **View modes:** `auto`, `2d` (tilt locked to 0°, morph still active), `manual` (user-chosen tilt persists at every zoom). The 3D button sets `manual` with a default tilt. Heading is always user-chosen; the compass resets north.
- **Chosen vs applied:** the camera stores `chosen` and `applied` tilt and heading. Constraints (terrain collision, sky-filling tilt at high altitude, max tilt) clamp only `applied`; each frame `applied` relaxes back toward `chosen` once the constraint allows.
- **Poles and antimeridian:** Web Mercator imagery stops near ±85.05°; polar caps are filled from geographic-scheme imagery (the global fallback covers the poles) on the globe and clipped on the flat map. Longitude wraps continuously: the flat map repeats horizontally and tile keys wrap.

## 6. Tiling and level of detail

- **Tiling schemes:** `TilingScheme` maps tile keys to geographic extents in a CRS. Built in: Web Mercator quad (1×1 root), geographic (2×1 root), and custom TMS/WMTS tile matrix sets with reprojection for any CRS (through a projection library, chosen by ADR in M7).
- **Tile keys:** a packed numeric quadtree index `(4^level − 1) / 3 + y · 2^level + x` (exact in float64 up to level 25) for map keys and pools; `{level, x, y}` views are computed on demand.
- **Selection:** screen-space error `sse = geometricError · viewportHeightPx / (2 · distance · tan(fovY / 2))`, refining while `sse > maxSse` (quality preset, motion-aware). Terrain and imagery select independently, so detailed imagery drapes on coarser terrain.
- **Replacement:** a parent stays drawn until every child needed to replace it is ready (or known to have no data); missing tiles render their best ready ancestor, upsampled (UV sub-rectangle). The pinned base (levels 0–N, configurable) loads at start and is never evicted, so there is always a complete picture.
- **No popping:** a tile that becomes ready fades in over a short, time-based interval while its ancestor stays underneath; terrain geomorphs vertex heights between levels.
- **No seams:** imagery uses edge-clamped sampling of the tile's own texture with mip levels built per tile (or gutters when tiles are atlased); terrain hides level cracks with skirts (proposed; stitching if the survey shows skirts fail under steep tilt).
- **Culling:** frustum culling against bounding volumes in float64, horizon culling with an ellipsoid occluder (and terrain max heights).
- **Tile states:** `unloaded → queued → loading → decoding → decoded → uploading → ready`, plus `failed` (retry with backoff) and `noData` (terminal: stay on the parent, never retry).

## 7. Loading pipeline

```
selection ─▶ wanted tiles (priority) ─▶ policy ─▶ cache hierarchy ─▶ scheduler ─▶ workers ─▶ upload queue ─▶ ready
                                         │          GPU→RAM→persistent→package→network
                                         └─ network mode, loading switches, provider profile, coverage
```

- **Priority:** visible before prefetch, coarse before fine, screen center first (distance from center in screen space), destination of a flight before the path.
- **Scheduler:** binary-heap queue; concurrency limits per host and per provider profile; `AbortController` cancellation of requests no longer wanted (essential during flights); retries with exponential backoff and jitter; timeouts; request coalescing so the same tile is never fetched twice concurrently, and the cache hierarchy ensures it is never downloaded twice.
- **Workers:** decoding (images via `createImageBitmap`, terrain meshes, vector tiles, labels, clustering) runs in a worker pool; buffers move as transferables.
- **Upload budget:** GPU uploads are drained within a per-frame time and byte budget, so no frame stutters when many tiles arrive together.
- **Compression:** KTX2/Basis transcoding in workers where the source provides it, chosen per device capability.
- **Motion-aware detail:** while the camera moves fast, `maxSse` rises and prefetch shrinks; detail refines when motion slows or stops.
- **Flight preloading:** when a flight starts, the path is sampled; the destination at its arrival levels is requested first, then only tiles that will be visible along the path at the levels needed there, capped by the bandwidth estimate.

## 8. Network modes, cache and offline

- **Modes:** `online` (never reads offline packages), `offline` (never touches the network, health checks included), `hybrid` (default: packages give an instant base, the network adds detail).
- **Loading switches:** persistent cache, memory reuse, prefetch and flight preloading, offline packaging. All on by default; set globally, per layer or per source, changeable at runtime. The effective value per source is `global ∧ override ∧ profileAllows`: a provider profile can only switch features off. With memory reuse off, the working set needed for the current view still stays resident.
- **Persistent cache:** a `CacheStore` interface with IndexedDB and OPFS implementations (choice per environment by ADR in M8), quota handling, eviction awareness, and `navigator.storage.persist()` exposed to apps. Entries carry source id, version/ETag and expiry from cache headers and provider terms.
- **Offline packages:** **Proposed:** PMTiles as the package format (single file, HTTP range requests from a LAN server, random access from OPFS/IndexedDB on a device), with a JSON manifest (id, version, sources, area, zoom range, license, attribution, checksums). MBTiles is supported as an import/source format. One package format serves both offline modes.
- **Package builder:** isomorphic logic in `offline` (used in the browser for device downloads and by the `tools` CLI): area (bbox or polygon), zoom range, sources whose profiles allow packaging; size estimate before building; resumable; integrity checks.
- **Connectivity:** health checks against the configured tile endpoints (not `navigator.onLine` alone), with backoff; transitions are seamless because the cache hierarchy already falls back.
- **Bandwidth:** throughput estimated from measured network downloads (EWMA, cache hits excluded); it bounds flight detail, prefetch depth and concurrency, like adaptive video streaming.

## 9. Renderer

- **Interface:** `RendererBackend` is defined in core; the engine hands it a frame description (camera matrices, ordered batches of tile meshes with their imagery, layer batches, overlays) and resource commands (create, upload, release). Everything above that line is engine logic.
- **Implementation (proposed, confirm in the GPU survey, ADR in M2):** three.js `WebGPURenderer` at a pinned version, which selects WebGPU and falls back to WebGL2 automatically (forceable for tests); shaders in TSL compile to WGSL and GLSL. Automatic matrix updates and three.js frustum culling are disabled (the engine culls and computes matrices); texture uploads are explicit so the upload budget holds. Devices without WebGL2 get a clear error event and message.
- **Draw efficiency:** tiles share geometry where possible (heightmap terrain from a shared grid + height texture; quantized-mesh terrain per tile), imagery per terrain tile composed in one draw with texture arrays where supported; state-sorted batches; instancing for markers.
- **Loss recovery:** WebGPU `device.lost` and WebGL `webglcontextlost/restored` rebuild GPU resources from CPU-side caches without reloading the page; the view stays on the last good frame meanwhile.
- **OffscreenCanvas:** rendering from a worker is evaluated in M2 with measurements; adopted only if it improves frame-time stability without breaking input latency or browser coverage.
- **Hot paths:** replaced with lower-level code only when profiling proves a bottleneck; a fully custom backend is acceptable if measurements justify it (ADR required).

## 10. Data layers

- **Storage:** features in structure-of-arrays typed buffers per layer; single-feature updates patch buffers in place (dirty ranges), no rebuild.
- **Primitives:** points/markers/billboards (instanced), labels, polylines, polygons, extruded polygons, circles and ellipses (geodesic), glTF models.
- **Placement:** draped (rendered into the terrain tiles' overlay pass so they follow relief at every level), ground-clamped (re-sampled when terrain detail changes) or absolute altitude.
- **Styling:** one expression evaluator implementing MapLibre Style Specification semantics, shared by data layers and vector tiles (data-driven and zoom-dependent).
- **Clustering:** hierarchical spatial index built in a worker; LOD for markers; 100,000 points at the target frame rate.
- **Labels:** SDF glyphs generated in workers and atlased; screen-space collision grid with priorities; placement stable across frames (no flicker).
- **Picking:** GPU id buffer read asynchronously for features; CPU ray–terrain intersection for bare terrain; events carry feature, geographic position and screen point.

## 11. Controls and animation

- Pointer Events unify mouse, pen and touch; gesture recognizers produce semantic intents (pan, zoom at point, rotate, tilt) consumed by navigation logic in core terms.
- Inertia from velocity sampled over the last ~100 ms, decayed by elapsed time (frame-rate independent).
- `flyTo` follows a smooth zoom-out/zoom-in path (van Wijk and Nuij); `easeTo` for short moves; `jumpTo` teleports; tours queue waypoints. All return cancellable promises and emit events, and keep the user's tilt and heading unless the call sets them.
- Reduced motion: flights become quick fades; inertia shortens.
- Keyboard: the container is focusable; arrows pan, Shift+arrows rotate/tilt, +/- zoom.

## 12. UI and framework adapters

- `@vibeglobe/ui`: each control is a small class with `mount(container)`/`destroy()`, styled by CSS variables (light and dark themes), labeled via a pluggable translation dictionary (English and Italian shipped), keyboard-operable with ARIA labels. Attribution is a control the layout never covers.
- `@vibeglobe/vue`: `<VibeGlobe>` component plus composables (`useGlobe`, `useCamera`, `useLayer`); creates the engine in `onMounted` only, so SSR renders a placeholder and hydration attaches the engine.
- `@vibeglobe/web-component`: `<vibe-globe>` element defined by an explicit `defineVibeGlobe()` call; attributes for the common options, properties for the full API.

## 13. Threading, assets and CSP

- One shared worker pool (size from `hardwareConcurrency`, capped) with task types for each decoder.
- Workers, WebAssembly and other assets are separate files resolvable by bundlers (`new URL(..., import.meta.url)`) and overridable by configurable base URLs. No `eval`, no `new Function`, no blob-URL code, so the engine runs under a strict Content Security Policy.

## 14. Errors and validation

- Validate at the boundaries: configuration (typed validators with clear messages), network responses (status, size limits, content checks), decoders (bounds-checked parsing, fuzzed), packages (manifest and checksums), coordinates (parsers with explicit errors). Internal code trusts validated data.
- A failing tile never blanks the view: it falls back to its ancestor and reports a typed `tile-error` event. Corrupted data is quarantined, not retried endlessly.

## 15. Observability

- Debug overlay (`?debug=1` in the playground, `globe.debug` in the API): tile boundaries and levels, screen-space error, source per tile, cache hits and misses, requests in flight, GPU and RAM use, frame time and rate.
- Performance marks visible in browser profilers; a compact HUD.
- Logger with levels and trace categories (tiles, requests, camera); silent by default. No telemetry: nothing is sent anywhere except the configured sources.
