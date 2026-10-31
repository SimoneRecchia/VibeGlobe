# Architecture

The engine is a framework-agnostic TypeScript core that owns all globe logic (geodesy, camera, view modes, tiling, scheduling, caching policy), with the renderer, input handling, sources, data layers, offline storage and UI attached as plug-ins through interfaces the core defines. Framework adapters (Vue 3, Web Component) wire the plug-ins together for consumers.

## 1. Packages

npm workspaces monorepo ([ADR 0002](../adr/0002-monorepo-and-tooling.md)). All publishable packages use the `@vibeglobe/` scope and are published on the public npm registry under the `vibeglobe` organization, under the PolyForm Noncommercial License 1.0.0 ([ADR 0015](../adr/0015-owner-decisions-2026-10-20.md)).

| Package                    | Path                            | Responsibility                                                                                                                                                                                                                                                                                                                                                                                 | Depends on                               |
| -------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `@vibeglobe/core`          | `packages/core`                 | Math (float64 vectors and matrices, pooled), WGS84 geodesy, projections and the globe-to-flat morph, camera model, view modes (chosen vs applied), animations, tiling schemes and quadtree, level-of-detail selection, request scheduler, memory cache and residency, loading policy (network mode, switches, provider profiles), events, the `createGlobe` facade and every plug-in interface | nothing at runtime                       |
| `@vibeglobe/renderer`      | `packages/renderer`             | `RendererBackend` implementation on three.js `WebGPURenderer` (WebGPU, automatic WebGL2 fallback), TSL shaders, GPU resource management, upload budget, picking buffer, device/context loss recovery                                                                                                                                                                                           | core, three (pinned)                     |
| `@vibeglobe/sources`       | `packages/sources`              | Source adapters (XYZ/TMS, WMTS, WMS, PMTiles, MBTiles, georeferenced image, quantized-mesh, Terrarium, Terrain-RGB, GeoJSON, KML, GPX, MVT, glTF, 3D Tiles), decoders that run in workers, reprojection, provider profiles (Google, OpenStreetMap)                                                                                                                                             | core                                     |
| `@vibeglobe/layers`        | `packages/layers`               | Data primitives, clustering, labels (SDF), styling expressions (MapLibre Style Specification semantics), picking and feature events, draping and ground clamping, vector-tile and building rendering                                                                                                                                                                                           | core, renderer                           |
| `@vibeglobe/controls`      | `packages/controls`             | Pointer, wheel, touch and keyboard input; gesture recognizers; inertia; navigation logic that drives the core camera API                                                                                                                                                                                                                                                                       | core                                     |
| `@vibeglobe/offline`       | `packages/offline`              | Persistent cache stores (IndexedDB / OPFS), offline package reader and installer, package management API, connectivity monitor, bandwidth estimator, in-browser package downloads                                                                                                                                                                                                              | core, sources                            |
| `@vibeglobe/ui`            | `packages/ui`                   | Optional ready-made DOM controls (vanilla TypeScript + CSS variables), theming, English and Italian, accessibility                                                                                                                                                                                                                                                                             | core                                     |
| `@vibeglobe/vue`           | `packages/vue`                  | Vue 3 components and composables, SSR-safe                                                                                                                                                                                                                                                                                                                                                     | core, renderer, controls, ui (peer: vue) |
| `@vibeglobe/web-component` | `packages/web-component`        | `<vibe-globe>` custom element, registered only by an explicit call                                                                                                                                                                                                                                                                                                                             | core, renderer, controls, ui             |
| `@vibeglobe/worker`        | `packages/worker` (added in M3) | The single prebuilt worker program that runs every decoder and mesh task in the shared pool (ADR 0011)                                                                                                                                                                                                                                                                                         | core, sources, layers                    |
| `@vibeglobe/tools`         | `packages/tools`                | Node CLI: dataset pipeline, offline package builder, license audit and notices                                                                                                                                                                                                                                                                                                                 | core, sources, offline                   |
| playground                 | `apps/playground`               | Demo app exercising every feature; bed for visual, scenario and performance tests                                                                                                                                                                                                                                                                                                              | everything                               |
| docs site                  | `typedoc.json`, `docs/guides/`  | Documentation site (TypeDoc) with the guides and the API reference generated from the types, built to `docs-site/`                                                                                                                                                                                                                                                                             | —                                        |
| Nuxt example               | `apps/nuxt-example`             | SSR integration test bed for the Vue adapter                                                                                                                                                                                                                                                                                                                                                   | vue                                      |

Dependency rules (checked in CI from M1):

- No package depends on Vue, Nuxt, React or Cube, except `@vibeglobe/vue` on Vue. Nothing anywhere refers to Cube.
- `core` has no runtime dependencies and compiles without the DOM library, so nothing in it can touch `window`, `document` or the GPU at import time. Browser APIs are reached only through plug-ins created by the application at runtime.
- three.js is imported only inside `renderer` (and `layers` through the renderer's exported helpers). Swapping the backend never touches globe logic.
- Every package is ESM, `sideEffects: false`, with no top-level side effects: importing it under SSR is always safe (tested for every package).
- Third-party runtime dependencies need a permissive license and an ADR; the license audit enforces the allow-list.

## 2. Runtime model

`createGlobe(options)` builds one engine instance bound to a container element. Several instances can live on one page; they share nothing but the worker pool (ADR 0011), the network pool (ADR 0007) and the persistent cache store, all reference-counted.

The frame loop runs on `requestAnimationFrame` only while something changes (render on demand). Each frame:

1. **Clock:** time step from the rAF timestamp, clamped so a long pause never produces a jump.
2. **Input:** controls apply pending gestures to camera targets; inertia decays by elapsed time.
3. **Animation:** active `flyTo`/`easeTo`/tour advance by elapsed time; any user input cancels them, starting from the applied camera so nothing jumps.
4. **View resolution:** zoom drives the morph factor, tilt curve and relief scale (Auto mode) or the user's chosen values (2D locked, manual); constraints and terrain collision produce the applied values without touching the chosen ones.
5. **Camera:** float64 camera state; a rotation-only view matrix and a reversed-Z projection with an infinite far plane (ADR 0004, ADR 0005), per-draw eye-relative offsets, frustum planes, horizon-culling occluder.
6. **Selection:** one quadtree of drawn surface tiles is traversed with frustum and horizon culling; each tile refines while any layer needs more detail (terrain by screen-space error, each imagery layer by its projected texel size), producing a render set that shows the best resident ancestor data where needed and a list of wanted tiles with priorities (ADR 0006).
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

**Decided (ADR 0004, [survey](../research/precision.md)):** all CPU math in float64, rounded to float32 only at upload. The eye is the world origin every frame and the uploaded view matrix is rotation-only. Every piece of GPU geometry (tile, data-layer cell, model, 3D Tiles content) has a float64 origin and small float32 offsets from it; each frame the CPU computes origin − eye per drawn chunk and uploads it as two float32 parts, which shaders add before the rotation. Long primitives are split into spatial chunks (no per-vertex high/low positions), with a chunk radius of at most 1000 × its distance from the eye. Positions never use GPU trigonometry. Morph vertices carry globe and flat offsets, blended eye-relative, with dedicated pipelines for the pure globe (m = 0) and pure flat (m = 1) cases. Acceptance: no vertex jitter at 1 m altitude anywhere on Earth on both backends (sub-millimeter camera moves, screen-space variance below 0.1 px).

## 4. Depth

**Decided (ADR 0005, [survey](../research/depth.md)):** one encoding everywhere: reversed depth `z = near / d` with an infinite far plane in a 32-bit float attachment, cleared to 0 and tested greater-equal. WebGPU uses `depth32float` natively; WebGL2 uses `EXT_clip_control` where exposed (Chrome, Edge, Safari) and otherwise writes the same value from the fragment shader (Firefox), at a GPU cost measured in M2. The near plane is `min(0.1 m, 0.5 × camera clearance)`, floored at 1 mm; no depth bias or polygon offset. Multi-frustum rendering and logarithmic depth are not used. Acceptance: no z-fighting between near terrain, data layers and far geometry from orbit to 1 m altitude on both backends.

## 5. Globe, flat map and oblique view

One continuous camera; the shape morphs, nothing switches.

- **Morph (ADR 0008):** the camera sits in the east-north-up frame of its target point (the anchor) and its pose does not depend on the morph factor. Vertices hold globe (WGS84) and plane (Web Mercator scaled to match the ground at the anchor) offsets, precomputed in float64 by workers; the vertex shader blends them linearly by `m` (eased, no thresholds). One morph function serves the GPU and the CPU paths (picking, labels, culling).
- **Anchor:** the screen-center point stays fixed by construction; the point under the cursor stays fixed through a small float64 solve for the camera target each frame (at most 3 iterations), shared with pan and zoom-at-cursor (ADR 0009).
- **Curves:** morph, tilt and relief are eased functions of ground zoom (independent of latitude), following the phase table of `PLAN.md`: a 0° 2D band at region and city scale, tilt rising only at neighborhood scale, each curve easing in and out at its ends (ADR 0015, decision 9). Values are tuning constants in one module, covered by continuity tests (no derivative jumps).
- **Relief on the flat plane:** heights are scaled per vertex by the Mercator scale factor, exact at the anchor, so relief stays consistent with the plane; measurements always use the ellipsoid.
- **View modes:** `auto`, `2d` (tilt locked to 0°, morph still active), `manual` (user-chosen tilt persists at every zoom). The 3D button sets `manual` with a default tilt. Heading is always user-chosen; the compass resets north.
- **Chosen vs applied:** the camera stores `chosen` and `applied` tilt, heading and range (ADR 0009). Constraints (terrain collision, sky-filling tilt at high altitude, max tilt, zoom limits, bounds) clamp only `applied`; each frame `applied` relaxes back toward `chosen` once the constraint allows.
- **Poles and antimeridian:** Web Mercator imagery stops near ±85.05°; polar caps are geographic tiles textured from the global fallback, kept on the flat map as a strip beyond ±85°. Each tile is placed at the longitude copy nearest the anchor, so the antimeridian never shows a seam and no world copies are drawn.

## 6. Tiling and level of detail

- **Tiling schemes:** `TilingScheme` maps tile keys to geographic extents in a CRS. Built in: Web Mercator quad (1×1 root), geographic (2×1 root), and custom TMS/WMTS tile matrix sets with reprojection for any CRS (through a projection library, chosen by ADR in M7).
- **Tile keys:** `{ root, level, x, y }`, with root 0 for the Web Mercator quadtree and 1 and 2 for the north and south polar caps (ADR 0006, ADR 0013); the packed numeric key adds the root above the quadtree index `(4^level − 1) / 3 + y · 2^level + x` (exact in float64 up to level 25) for map keys and pools.
- **Selection (ADR 0006, [survey](../research/level-of-detail.md)):** a single quadtree of drawn surface tiles: Web Mercator up to ±85.0511° plus two geographic polar-cap roots (tile keys carry a root id). A surface tile refines while any layer needs more detail: terrain by screen-space error `sse = geometricError · viewportHeightPx / (2 · distance · tan(fovY / 2))` (2 px default), each imagery layer by its own projected texel size (1.5 render-target px default), so imagery levels never depend on terrain levels. Hysteresis avoids oscillation; a hard cap of 1,000 drawn tiles bounds the work; motion and quality presets raise the thresholds.
- **Fallback:** refinement never waits for data. A new tile immediately draws the best resident ancestor data of each layer as a UV sub-rectangle; data a drawn tile uses stays resident, so a parent's data is never released before the children that replace it are ready. The pinned base (levels 0–N, configurable, up to 1/8 of the GPU budget) is never evicted, so there is always a complete picture.
- **No popping:** when the data a tile shows changes, its shader blends old to new over about 250 ms, for every imagery layer and for terrain heights (a time-based geomorph that ends exactly on the target surface). Parent and child are never drawn at the same time.
- **No seams:** imagery uses edge-clamped sampling of each tile's own texture with per-tile mip levels (or gutters when atlased). Every terrain source is converted to height grids in workers (quantized-mesh is rasterized), and each tile gets its own vertex buffer of float32 globe and plane offsets from its float64 origin, with index buffers shared per grid size (ADR 0013); skirts sized from the two levels' geometric errors hide cracks.
- **Culling:** frustum culling against bounding volumes in float64, horizon culling with an ellipsoid occluder (and terrain max heights). Tiles beyond the morph-aware horizon distance are culled on the CPU; this also hides the flat map's antimeridian cut, since the far plane is infinite (ADR 0013).
- **Tile states:** `unloaded → queued → loading → decoding → decoded → uploading → ready`, plus `failed` (retried with randomized exponential backoff, at most 4 times, and only while the tile is still wanted) and `noData` (404, 410, 204 or out of coverage: terminal, stay on the parent, never retry). Details in ADR 0007.

## 7. Loading pipeline

```
selection ─▶ wanted tiles (priority) ─▶ policy ─▶ cache hierarchy ─▶ scheduler ─▶ workers ─▶ upload queue ─▶ ready
                                         │          GPU→RAM→persistent→package→network
                                         └─ network mode, loading switches, provider profile, coverage
```

- **Priority:** visible before prefetch, coarse before fine, screen center first (distance from center in screen space), destination of a flight before the path.
- **Scheduler:** binary-heap queue; concurrency limits per host and per provider profile; `AbortController` cancellation of requests no longer wanted (essential during flights); retries with exponential backoff and jitter; timeouts; request coalescing so the same tile is never fetched twice concurrently, and the cache hierarchy ensures it is never downloaded twice.
- **Workers (ADR 0011):** decoding (images via `createImageBitmap`, terrain meshes, vector tiles, labels, clustering) runs in one page-wide pool of module workers from a single prebuilt worker program (`@vibeglobe/worker`, added in M3); the main-thread scheduler fetches and transfers buffers, workers return `ImageBitmap`s or flat typed arrays.
- **Upload budget:** GPU uploads are drained within a per-frame time and byte budget, so no frame stutters when many tiles arrive together.
- **Compression:** KTX2/Basis transcoding in workers where the source provides it, chosen per device capability.
- **Motion-aware detail:** while the camera moves fast, `maxSse` rises and prefetch shrinks; detail refines when motion slows or stops.
- **Flight preloading:** when a flight or an ease starts (`FlightPlan`, F670), the destination's view at its arrival levels is planned, its ancestors four levels up first, then the views at twelve times along the van Wijk path, at the detail their speed allows, each tile with the time it is first shown, and a margin ring three levels coarser; each frame the destination counts as needed within a second and every other tile is requested from two seconds before its time, so they load in the order the movement needs them, terrain included, and a smoothed zoom's target loads the same way (F671). Layers are included as the movement's deepest zoom shows them. Requests keep the preload class: after every visible tile, before prefetch.

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
- **Implementation (Decided, ADR 0010, [survey](../research/gpu-and-renderer.md)):** three.js `WebGPURenderer` pinned to exactly `three@0.186.1`, imported only from `three/webgpu` and `three/tsl` inside `packages/renderer`; WebGPU first with automatic WebGL2 fallback (forceable for tests), plus a startup self-test that falls back to WebGL2 on any error or loss in the first WebGPU frame. Shaders in TSL compile to WGSL and GLSL. The engine owns matrices, projection, sort keys and culling (automatic matrix updates and frustum culling off; TSL's float32 model-view product never used). One shared material per variant with per-tile textures and uniforms, all variants compiled before the first frame; a tile becomes drawable only after an explicit upload paid from the per-frame upload budget. Upgrades go one release at a time through the full test gate; r187 is required before M4.
- **Draw efficiency:** per-tile vertex buffers with shared index buffers per grid size (ADR 0013); one draw per tile by default, with a pre-approved switch to instanced texture arrays if the WebGL2 renderer's CPU time exceeds 3 ms p95 at the reference tile count (ADR 0010); state-sorted batches; instancing for markers.
- **Loss recovery:** r186 cannot restore a lost device in place, so on WebGPU `device.lost` or WebGL `webglcontextlost` the engine creates a new renderer on a new canvas and rebuilds GPU resources from the encoded tile bytes kept in the RAM cache, decoded again in workers with the pinned base first (ADR 0007, ADR 0010); after 3 failed attempts in 60 s it reports a typed error. Loss events from already destroyed renderers are ignored.
- **OffscreenCanvas:** rendering from a worker was evaluated in M2 with measurements and not adopted: it added input latency and misaligned DOM overlays (ADR 0019). The renderer can still draw into an OffscreenCanvas.
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

- Pointer Events unify mouse, pen and touch. Input is recorded as events arrive and applied once per frame; gesture recognizers produce semantic intents (pan, zoom at point, rotate, tilt), and a gesture re-bases with zero movement when a finger is added or lifted (ADR 0009).
- Inertia from the velocity over the 80 ms ending at release (a drag that paused does not glide), evaluated in closed form from elapsed time, so it follows the same path at any refresh rate.
- `flyTo` follows a smooth zoom-out/zoom-in path (van Wijk and Nuij); `easeTo` for short moves; `jumpTo` teleports; tours queue waypoints. All return cancellable promises and emit events, and keep the user's tilt and heading unless the call sets them.
- Reduced motion: flights become quick fades; inertia shortens.
- Keyboard: the container is focusable; arrows pan, Shift+arrows rotate/tilt, +/- zoom.

## 12. UI and framework adapters

- `@vibeglobe/ui`: each control is a small class with `mount(container)`/`destroy()`, styled by CSS variables (light and dark themes), labeled via a pluggable translation dictionary (English and Italian shipped), keyboard-operable with ARIA labels. Attribution is a control the layout never covers.
- `@vibeglobe/vue`: `<VibeGlobe>` component plus composables (`useGlobe`, `useCamera`, `useLayer`); creates the engine in `onMounted` only, so SSR renders a placeholder and hydration attaches the engine.
- `@vibeglobe/web-component`: `<vibe-globe>` element defined by an explicit `defineVibeGlobe()` call; attributes for the common options, properties for the full API.

## 13. Threading, assets and CSP

- One page-wide pool of stateless module workers (ADR 0011): it starts with one worker and grows on backlog up to `clamp(hardwareConcurrency − 2, 1, 4)`; a startup handshake checks the build id, and a main-thread executor takes over if workers cannot start. Worker and WebAssembly URLs are same-origin.
- Workers, WebAssembly and other assets are separate files resolvable by bundlers (`new URL(..., import.meta.url)`) and overridable by configurable base URLs. No `eval`, no `new Function`, no blob-URL code, so the engine runs under a strict Content Security Policy.

## 14. Errors and validation

- Validate at the boundaries: configuration (typed validators with clear messages), network responses (status, size limits, content checks), decoders (bounds-checked parsing, fuzzed), packages (manifest and checksums), coordinates (parsers with explicit errors). Internal code trusts validated data.
- A failing tile never blanks the view: it falls back to its ancestor and reports a typed `tile-error` event. Corrupted data is quarantined, not retried endlessly.

## 15. Observability

- Debug overlay (`?debug=1` in the playground, `globe.debug` in the API): tile boundaries and levels, screen-space error, source per tile, cache hits and misses, requests in flight, GPU and RAM use, frame time and rate.
- Performance marks visible in browser profilers; a compact HUD.
- Logger with levels and trace categories (tiles, requests, camera); silent by default. No telemetry: nothing is sent anywhere except the configured sources.
