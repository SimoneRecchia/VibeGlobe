# M3 Imagery streaming: implementation plan

How M3 ("scripted zoom and pan scenarios show zero black pixels and no popping") gets built on top of M2. The decisions come from ADR 0006 (level of detail), 0007 (scheduler and caches), 0010 (renderer), 0011 (workers), 0012 (testing), 0015 (owner decisions), 0018 (zero-allocation frame loop) and 0020 (KTX2); this document turns them into increments, modules and tests. Where it decides something the ADRs leave open, it says so; those points go into ADR updates when the increment that needs them starts.

Starting point (2026-10-21): M2 still has F078 (acceptance) and F545 (CI on `main`) open, so M3 starts once they pass. `packages/core/src/tiling/` already holds the Web Mercator and geographic `TilingScheme`s and packed `TileKey`s with a root id (F080's tests). The engine still draws M2's geographic surface quadtree (`surface/surface-selection.hot.ts`, its own `surfaceTileKey`) with one equirectangular base texture (`ThreeBackend.setBaseImagery`).

## 1. Scope and order of work

M3 covers F079–F125 (47 entries). Most entries need shared machinery that a later entry in file order also needs (F081's step 2 needs the debug tile view of F116; F082 needs workers, the scheduler and the upload queue), so work is grouped into increments. Each increment starts from the feature `npm run status` prints as Next, builds what that feature's steps need, and marks every feature whose steps then pass end to end. The order below follows the file order closely, so Next moves forward with each increment. The playground keeps working after every increment, and M2's suites (completeness, jitter, z-fighting, leaks, allocations, lifecycle) stay green throughout.

| #   | Increment                                 | Completes                                 | End-to-end proof                                                                                                                                                                                                                            |
| --- | ----------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | Preconditions and document sync           | F079                                      | Survey steps checked; `architecture.md`, `api.md` and `quality.md` updated where ADRs 0006, 0007, 0010 and 0011 said "updated when M3 starts", plus the draw-call budget F103 needs (section 3)                                             |
| 1   | Mercator surface quadtree with polar caps | F080, F086, F087                          | Unit and property tests of the new traversal; minimal debug tile view (outlines, level) showing nothing selected off screen or beyond the horizon; M2 suites unchanged on both backends                                                     |
| 2   | Fixture tile server and frame harness     | none (enabling)                           | Detector self-tests: each detector catches its injected defect on the base imagery and passes clean runs; request log and fault rules unit-tested                                                                                           |
| 3a  | Worker pool and image decoding            | none yet (F114 waits for the KTX2 reader) | Pool unit tests with fake endpoints (order, cancellation, crash, timeout, handshake, inline fallback, zero workers after the last destroy); decode task fuzzed in Node and in a Playwright page                                             |
| 3b  | Streaming slice                           | F081, F082, F083, F085, F088, F099, F100  | Playground on tiled imagery from the fixture server; per-frame sentinel check while zooming with a delayed child, failing levels and a throttled server; request order after a jump; trace shows decoding on worker threads; strict-CSP run |
| 4   | Memory: RAM tier, budgets, uploads        | F084, F097, F098, F101, F102              | Small budgets with wide navigation: usage never above budget, pinned and drawn tiles never evicted, no request on return, uploads once per residency, per-frame upload budget held during a 200-tile burst                                  |
| 5   | Network robustness                        | F089–F096, F112, F113                     | Fault rules: two hosts with limits, Milan–Tokyo path cancellations, 503 then success, permanent failure, stalls, 404 areas, coverage, HTTP/2 server, corrupt bytes, high latency; zero sentinel pixels in every run                         |
| 6   | Draw efficiency and KTX2                  | F103, F104, F114                          | Draw and pipeline counts per canonical view within budget; KTX2 fixtures on every forced target and the RGBA8 fallback on both backends; fuzz suite over every imagery decoder                                                              |
| 7   | Visual quality                            | F105–F111                                 | Popping, seam, shimmer and color checks in recorded frames; DPR 2 and resolution scale; `pole-orbit` and `antimeridian-pan` on both backends                                                                                                |
| 8   | Start-up and observability                | F115–F121                                 | Start-up benchmark from `vite preview`; overlay values equal the stats API; marks in a trace; HUD overhead; log levels and sinks; exported trace contents                                                                                   |
| 9   | Scenario suite, benchmarks, acceptance    | F122, F123, F124, F125                    | Full scenario suite on both backends with injected defects caught; streaming benchmarks stored per commit and compared; fresh-context review (ADR 0021)                                                                                     |

Visual baselines change three times (increments 1, 3b and 7). ADR 0012 lets only the pinned CI environment record them, so each of those increments ends with the manual baseline workflow and a commit that says why.

## 2. Architecture

### 2.1 Modules per package

| Package                | New or changed files                                                                                                         | Responsibility                                                                                                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| core `tiling/`         | existing                                                                                                                     | Schemes, packed keys, parent and children                                                                                                                                                                 |
| core `surface/`        | `surface-quadtree.hot.ts` (replaces `surface-selection.hot.ts`), `surface-mesh.ts`, `surface-cache.ts`, `transitions.hot.ts` | Traversal of three roots, culling, refinement by terrain sag and imagery texel size, mesh building and mesh LRU, from/to transition state per drawn tile and layer                                        |
| core `imagery/`        | `imagery-source.ts`, `imagery-levels.hot.ts`, `fallback.hot.ts`, `draw-list.ts`                                              | Source interface and validation, per-layer wanted level, best resident ancestor with its UV transform, the per-frame draw list                                                                            |
| core `scheduler/`      | `tile-table.ts`, `priority-heap.hot.ts`, `tile-scheduler.hot.ts`, `network-pool.ts`, `failure-policy.ts`, `worker-pool.ts`   | Pooled request records, heap, dispatch and cancellation per instance; page-wide host slots, rate limits and coalescing; failure classes and backoff; worker queue against injected endpoints              |
| core `cache/`          | `ram-tier.ts`, `residency.hot.ts`, `upload-queue.hot.ts`, `upload-cost.ts`, `pinned-base.ts`                                 | Encoded bytes, byte-accounted LRU over RAM and GPU, admission and protection, budgeted upload drain, cost model, pinned level choice                                                                      |
| core `diagnostics/`    | `engine-stats.ts`, `logger.ts`, `tracer.ts`                                                                                  | Counters of ADR 0007, levelled logger with sinks, ring-buffer trace                                                                                                                                       |
| sources                | `xyz-imagery.ts`, `fetch-transport.ts`, `tasks/decode-image.ts`, `ktx2/`                                                     | XYZ/TMS adapter (minimal; M7 completes it), `fetch` transport with abort and timeouts, worker task functions, KTX2 reader and transcode task                                                              |
| worker (new, ADR 0011) | `src/index.ts`, `src/vibeglobe-worker.ts`, `src/protocol.ts`                                                                 | `createWorkers()` endpoints with the literal `new Worker(new URL('./vibeglobe-worker.js', import.meta.url), { type: 'module' })`; the worker entry registering task functions; handshake; inline executor |
| renderer               | `tile-textures.ts`, `surface-material.ts`, `three-backend.ts`, `compressed.ts`                                               | Texture handles, `initTexture` uploads with timing and byte accounting, layer slots in the shared material, compressed textures, draw-list rendering                                                      |
| ui                     | `debug/tile-view.ts`, `debug/hud.ts`                                                                                         | Tile labels and counters, performance HUD                                                                                                                                                                 |
| playground, scripts    | `scripts/fixtures/tiles/`, `apps/playground/src/scenario-harness/`, Vite plugin                                              | Fixture tiles and faults, scenarios, in-page recorder and detectors                                                                                                                                       |

`scripts/checks/structure.ts` gains `@vibeglobe/worker` in `LIBRARY_PACKAGES` (progress notes). `core` stays DOM-free: `fetch`, `Worker`, `ImageBitmap`, `performance` and timers reach it only through the interfaces below.

### 2.2 Interfaces (sketches)

```ts
// core/imagery/imagery-source.ts — follows api.md TileSource; M7 adds profiles, auth and chains.
interface ImagerySource {
  readonly id: string;
  readonly tiling: TilingScheme;
  readonly minLevel: number;
  readonly maxLevel: number;
  readonly tileSizePx: number; // 256, 512, …; pixelRatio 2 halves the texel ground size
  readonly coverage?: readonly TileRectangleRad[]; // tiles outside are never requested (F094)
  readonly transport: TileTransport; // fetchTransport() from @vibeglobe/sources by default
  readonly decoder: 'image' | 'ktx2';
  /** Fills `out` with the URL and host index, or reports no data (out of coverage, beyond levels). */
  request(coord: TileCoord, out: TileRequest): TileRequest | 'noData';
}

// core/scheduler — DOM-free transport; sources implement it with fetch and AbortController.
interface TileTransport {
  start(request: TileRequest, timeouts: TimeoutsMs, done: (result: TransportResult) => void): AbortHandle;
}
type TransportResult =
  | { kind: 'ok'; bytes: ArrayBuffer; contentType: string }
  | { kind: 'status'; status: number; retryAfterMs: number | undefined }
  | { kind: 'network-error' | 'timeout' | 'aborted' };

// core/scheduler/worker-pool.ts — ADR 0011 rules 1–6; endpoints come from @vibeglobe/worker.
interface WorkerEndpointFactory {
  readonly url: string;
  create(onMessage: (data: unknown) => void, onError: (reason: string) => void): WorkerEndpoint;
  inline(): Promise<TaskTable>; // after 3 start failures, and in Node tests
}

// renderer interface additions (core/globe/types.ts); setBaseImagery is removed in 3b.
interface RendererBackend {
  uploadTexture(handle: number, image: DecodedTile, cost: UploadCost): void; // writes ms and bytes into cost
  releaseTexture(handle: number): void;
  render(view: FrameView, draws: TileDrawList): boolean;
}

// core/imagery/draw-list.ts — struct of arrays, preallocated for the 1,000-tile cap, reused every frame.
interface TileDrawList {
  count: number;
  meshKeys: Float64Array; // surface tile key per draw
  latRangeRad: Float32Array; // south, north per draw (pole feather, geographic v)
  textures: Int32Array; // [draw][layer][from, to] texture handles, −1 for none
  uvTransforms: Float32Array; // [draw][layer][from, to] scaleU, scaleV, offsetU, offsetV
  fade: Float32Array; // [draw][layer] transition progress t
}
```

`GlobeOptions` gains `imagery: ImagerySource[]` (replacing `baseImageryUrl` in 3b), `workers: WorkerEndpointFactory` (required when any tile source is set; validation names the missing option), `memory`, `logger` and `debug` as in `api.md`. A missing worker factory is a configuration error rather than a silent main-thread fallback, so F099 cannot regress unnoticed.

### 2.3 Data flow per frame

```
clock → controls → camera
  → surface traversal (cull, refine, per-layer wanted level, priority, LRU touch in post-order)
  → transitions (advance t, start/finish from→to per drawn tile and layer)
  → scheduler.update (stamp wanted, drop unstamped queued, abort stale in flight, heapify, dispatch)
        ↳ async: transport done → RAM tier → worker task (transferred bytes) → decoded queue → requestRender
  → upload drain (priority order, ≤ 2 ms and ≤ 8 MB predicted) → state ready
  → residency trim (≤ 64 tiles or 1 ms) and mesh LRU
  → draw list (per drawn tile, per layer: from/to handle + UV transform + t)
  → renderer.render
  → idle check (moving, fading, decoded-not-uploaded, or refused → next frame; else `idle` when nothing queued or in flight)
```

Loading wakes the frame loop by events, not by spinning `requestAnimationFrame`: a decoded tile, a settled request that frees a slot, and the earliest retry time (one wake-up timer through the render host) each request a frame. While requests are only waiting on the network, nothing changes on screen, so no frame is drawn; `idle` still waits for them (ADR 0007).

### 2.4 The Mercator quadtree replaces M2's geographic quadtree

ADR 0006 §1: root 0 is the Web Mercator tree (±85.0511°), roots 1 and 2 are geographic polar caps spanning all longitudes. The cap rule of M2 (KB-043) moves into the cap roots unchanged; Mercator tiles need no polar rule, since they are conformal. The minimum drawn level stays 2 for the Mercator root (float32 offsets and frustum tests, ADR 0004); cap roots are refined until each cap tile spans at most 90° of longitude, so it lies inside one geographic column of the fallback source.

Meshes carry three texture coordinates per vertex: `u` (east fraction), `vMercator` and `vGeographic` (south fraction in the tile's own scheme and in latitude). A layer in the surface tile's scheme samples `(u, vMercator)`, a geographic layer `(u, vGeographic)`; the per-layer UV transform maps either into its source tile. Textures are uploaded from `ImageBitmap`s with `flipY = false` and v grows southward (ADR 0010 §6), which replaces M2's northward v and its element-image flip.

The switch-over is three commits:

1. `surface-quadtree.hot.ts` lands beside the old traversal with the same record shape plus `root`, and keys from `packTileKey`. The behavior tests of `surface.test.ts` (orbit coverage, float32-safe refinement at 1 m, far-side culling, minimum level, KB-012 coverage, KB-043 polar counts) are parameterized over both traversals.
2. `createGlobe` switches to it, still with the equirectangular base texture sampled through `vGeographic`. Every M2 end-to-end suite must pass unchanged; visual baselines move only by tessellation and are re-recorded if they exceed ADR 0012's tolerance.
3. The old traversal and `surfaceTileKey` are deleted. Tests whose subject was the deleted code (the geographic key layout) are retargeted to the new keys, with the reason in `docs/internal/test-changes.md`. The `?level=` mapping of the `drag-200/400/800` benchmarks is retuned to the same draw counts.

### 2.5 Per-layer levels, fallback and draws

- **Refinement** (ADR 0006 §2): a surface tile refines while the texel ground size of any imagery layer at the finest level the tile can carry, divided by the pixel size `p = 2·d·tan(fovY/2)/H`, exceeds `τ_imagery = 1.5`, with `H` in render-target pixels (CSS × DPR × resolution scale; today's `maxScreenErrorPx` is in CSS pixels and changes with F109). Coarsening below 0.8 × the threshold; at most 1,000 drawn tiles.
- **Wanted level per layer** is the coarsest level at or below the carried level that meets the threshold, clamped to the source's levels and coverage. Wanted tiles get ADR 0007's key `class × 1024 + level + 2·d`; requests also go to every second missing ancestor level, coarse first (F085).
- **Fallback** walks from the wanted level up to the deepest tile in state `ready` and writes its UV sub-rectangle (integer shifts, levels ≤ 25). The pinned base guarantees a hit; where no layer covers a tile, the shader draws a base color that is neither black nor the page background.
- **Cross-scheme in M3:** a layer in another scheme uses the deepest tile that contains the whole surface tile, never two or four. This costs sharpness only for the geographic fallback near its row boundaries; M7 generalizes it with reprojection (F141).
- **Draws:** one draw per surface tile with the shared material (ADR 0010 §4, §7). Each layer is a slot holding a from and a to texture, a UV transform each and `t`; M3 compiles the variants for one and two slots (the geographic fallback below a Mercator layer) at warm-up. Layer composition, opacity and chains are M7's. The slot abstraction (`handle + UV transform`) is the same whether a handle names a texture or a layer of a texture page, so ADR 0010's pre-approved switch to texture pages stays local to the renderer.
- **Meshes** are built on the main thread in M3 (M4 moves mesh building to workers, ADR 0013), within a per-frame mesh budget (proposed 1 ms, measured). A child whose mesh is not built yet keeps its parent drawn, the one exception ADR 0006 allows.

### 2.6 Zero-allocation frame rules (ADR 0018)

- Tile records are a struct of arrays (`TileTable`: state `Uint8Array`, priority and next-eligible time `Float64Array`, frame stamp, attempts, LRU links, texture handle `Int32Array`) per instance, grown on a slow path. Lookups by tile key use `IntegerKeyMap`, one per source.
- The heap holds record indices in an `Int32Array` keyed by a `Float64Array`; heapify, drop and dispatch allocate nothing.
- Traversal, level choice, fallback and transitions keep doubles in typed arrays and module-level scratch, use comparisons instead of `Math.min/max/abs`, and keep rare paths (cap splitting, coverage misses, retries) in their own functions (KB-033).
- Allowed allocations are per tile, not per frame: a transport promise, a worker message, an `ImageBitmap`, a mesh build, a trace export. `frame-allocation.test.ts` gains a streaming case with a fake transport and fake workers: zero bytes per frame on the frame path while tiles arrive.

## 3. Tile state machine and budgets

```
unloaded ─▶ queued ─▶ loading ─▶ decoding ─▶ decoded ─▶ (uploading) ─▶ ready
   ▲  ▲        │         │          │           │                         │
   │  └────────┴─dropped/aborted────┴───────────┘          evicted ───────┘
   │  retry eligible (transient, < 4 retries, still wanted)
   └── failed (transient)          terminal: failed (exhausted or corrupt), noData
```

| Transition           | Rule                                                                                                                                                                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unloaded → queued    | Wanted this frame, inside coverage and levels, not in the per-source negative set (100,000 keys), past `nextEligible`                                                                                                                                            |
| queued → loading     | A host slot is granted (6 per host, 16 for HTTP/2 or HTTP/3, 32 overall, rate limits); a RAM-tier hit goes straight to decoding                                                                                                                                  |
| loading → decoding   | Bytes arrive; they enter the RAM tier first, then transfer a copy to the worker task                                                                                                                                                                             |
| decoding → decoded   | `ImageBitmap` or compressed levels back on the main thread; enters the upload queue                                                                                                                                                                              |
| decoded → ready      | Drained within 2 ms and 8 MB per frame by the cost model (EWMA bytes per ms per backend and format); larger items slice across frames (`uploading`)                                                                                                              |
| → unloaded (cancel)  | Queued and not stamped: dropped at once. In flight: aborted after 2 frames and 100 ms unwanted, only when no consumer remains. Decode and upload of unwanted tiles: dropped, bitmap closed, bytes kept                                                           |
| → failed (transient) | 408, 429, 5xx, network error, timeout (10 s to headers, 30 s total, enforced by the transport's timers): `nextEligible = now + random(0, min(30 s, 0.5 s·2^attempt))`, `Retry-After` up to 60 s; 429 halves the host limit; 5 consecutive failures leave 1 probe |
| → failed (terminal)  | After 4 retries, or a payload the decoder rejects (corrupt: quarantined, one `tile-error`, never retried). Ancestors stay drawn                                                                                                                                  |
| → noData             | 404, 410, empty 204, out of coverage or levels; remembered, never requested again                                                                                                                                                                                |
| ready → evicted      | Only unprotected tiles; RAM eviction releases the GPU copy too; after a device loss every `ready` tile returns to decoding from RAM, pinned base first                                                                                                           |

**Protected tiles:** the pinned base, every tile the draw list references (fallback ancestors and both sides of running transitions included), and tiles with pipeline work in flight.

**Pinned base:** levels 0..N of each base source, with N the deepest level whose cumulative GPU size keeps the sum over all base sources within 1/8 of the GPU budget (a shared share, see risk 8). With 256 px RGBA8 tiles and the 512 MB default this is Mercator 0–3 (30 MB) and geographic 0–2 (15 MB). Pinned tiles load as class 0 and `ready` resolves at the first frame after they are all resident, which is also F084's "before refinement begins".

**Eviction and admission:** an intrusive LRU touched in post-order, frame marker excluding this frame's tiles, trim to 90% when over budget, at most 64 tiles or 1 ms per frame outside admissions. Predicted bytes are reserved at dispatch; a tile that cannot be admitted is refused and counted, the selection's error multiplier rises ×1.05 per frame (cap ×4) and relaxes ÷1.02 below 80%, and a debounced `memory-pressure` event fires. Decoded-not-uploaded bytes above 64 MB pause classes 2–4.

**Coalescing:** the page-wide `NetworkPool` keys in-flight requests by (source registration, tile key, variant); a second consumer, in the same instance or another, attaches to the request, and the bytes are copied for the second worker transfer. The RAM tier keeps each tile's encoded bytes for as long as its GPU copy lives, so a tile is downloaded twice only after both were evicted, which the request log reports separately (F095).

**Transitions** (ADR 0006 §4): T = 250 ms on the engine clock. Splits inherit the parent's pairs and `t` with sub-rectangle UVs; merges run the children toward the parent's data and keep them drawn until all four reach `t = 1`; changes while a tile is culled apply instantly. A running transition keeps frames coming only until it ends.

**Budgets added to `docs/internal/plan/quality.md` in increment 0** (F101 and F103 refer to them):

| Metric                        | Budget                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| Draw calls per frame          | Drawn surface tiles (≤ 1,000) plus overlay draws; independent of the number of imagery layers            |
| Pipeline switches per frame   | At most the number of material variants drawn (≤ 3 in M3); 0 pipeline compiles after warm-up             |
| Uploads per frame             | ≤ 2 ms and ≤ 8 MB; a burst of 200 arrivals drained within 15 frames                                      |
| Traversal and scheduler       | ≤ 1 ms p95 at 1,000 drawn tiles; scheduler update ≤ 0.3 ms p95 at 5,000 wanted tiles (reference desktop) |
| Main thread per received tile | ≤ 0.3 ms excluding upload; zero engine long tasks over 50 ms while streaming                             |
| Mesh building                 | ≤ 1 ms per frame (proposed, measured in 3b)                                                              |

## 4. Test fixtures

### 4.1 Fixture tile server

One module, `scripts/fixtures/tiles/`, used three ways, with no network access and no downloaded data (ADR 0015):

- **Vite plugin** in the playground (`configureServer` and `configurePreviewServer`): same-origin HTTP/1.1 under `/fixture-tiles/`. Default for the playground and most tests.
- **Standalone HTTP/1.1** on `localhost` and `127.0.0.1` (two hosts for F089), with CORS and `Timing-Allow-Origin`.
- **Standalone HTTP/2** over TLS with a committed test-only self-signed certificate for `localhost` (browsers have no cleartext HTTP/2); Playwright sets `ignoreHTTPSErrors` (F096). Started by Playwright's `webServer` list.

Tiles are generated on request from `{session}/{source}/{scheme}/{z}/{x}/{y}.{ext}` and cached in memory:

| Pattern         | Use                                                                                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `world`         | A smooth color field over the whole globe plus grid lines whose spacing follows the level: continuous across tiles and levels, so seams and wrong UVs show                                            |
| `levels`        | `world` tinted per level, so every refinement is visible to the popping detector                                                                                                                      |
| `border`        | Alternating strongly contrasting colors per tile parity with a 1 px edge stripe (F106)                                                                                                                |
| `patches`       | Known sRGB patches at native resolution (F108)                                                                                                                                                        |
| `stripes`       | High-frequency pattern for mip shimmer (F107)                                                                                                                                                         |
| `natural-earth` | The bundled Natural Earth image cut into a geographic pyramid (levels 0–3) and reprojected into a Mercator pyramid (levels 0–4) at server start, so the default playground still looks like the Earth |

Every palette keeps each channel at 40 or more and alpha at 255, so neither the black test nor the transparent-pixel sentinel can match real imagery. PNG is encoded with `pngjs` (already a development dependency). JPEG, WebP and AVIF variants and the KTX2 corpus (ETC1S and UASTC, opaque and alpha, broken variants, ADR 0020) are small committed fixtures produced by pinned scripts: image formats encoded once in Playwright's Chromium, KTX2 by a pinned `basisu`.

**Fault rules** are posted by a test to `/_fixture/{session}/rules` and matched by source, level and tile range: latency, bandwidth, status code, fail N times then succeed, never respond, truncate, random bytes, wrong content type, `Retry-After`. `GET /_fixture/{session}/log` returns every request with start, end, abort, status, bytes and connection id. A per-test session id keeps tests independent; F082's step uses Playwright route interception, which the same rules can replace.

### 4.2 Scenario harness

- **Scenarios** in `apps/playground/src/scenarios.ts`: `zoom-orbit-to-street`, `pan-fast`, `rotate`, `tilt-sweep`, `jump`, `path-milan-tokyo`, `pole-orbit`, `antimeridian-pan`. Each is a function of the frame index that alternates motion windows with static hold windows, run with `manualClockStepMs = 1000/60` and stepped by the test through `captureFrame()`, so fades and paths are deterministic while network arrival order may vary (ADR 0012).
- **In-page recorder** (`scenario-harness/`, loaded only with `?record=1`): detectors run in the page on each captured frame, keeping the previous two frames, and return counts plus the PNGs of offending frames. This avoids moving 2 MB per frame through `page.evaluate` at about 67 ms per capture on SwiftShader. Detectors are pure functions, unit-tested in Node.
- **Globe mask:** pixel centers whose ray hits the ellipsoid, computed in float64 from the camera, minus a 1 px band at the silhouette for anti-aliasing.

| Detector             | Invariant (zero tolerance)                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Holes (F122)         | After `ready`, no pixel inside the mask is transparent (the canvas clears to alpha 0, so alpha 0 is the sentinel) or darker than the fixture palette allows                                 |
| Popping (F105, F123) | In a static window, no pixel changes in one frame by more than the fastest a 250 ms fade allows (255 / 15 per channel at 60 Hz) plus 4                                                      |
| Flicker (F123)       | No A–B–A oscillation above 24 per channel across three frames in a static window or under sub-pixel moves                                                                                   |
| Seams (F106, F123)   | Along projected tile boundaries (from the debug tile snapshot), no run of 3 or more boundary pixels differing from both neighbors by more than the neighbors differ from each other plus 24 |
| Shimmer (F107)       | Frame differencing under slow motion over `stripes` stays within the baseline's tolerance                                                                                                   |

**Injected defects** (F122 step 3, F123 step 2) run as permanent tests through options rather than scratch branches: fade duration 0 (pop), a selection threshold alternating every frame (flicker), a fixture whose edge stripe is wrong (seam), and a debug fault that skips one tile's draw (hole). Each must fail its detector and name the frame.

**Fuzzing** (F114): fast-check arbitraries over random and mutated fixtures, in a Playwright page for `createImageBitmap` inside the real worker pool and in Node for the KTX2 reader and transcoder task, 2,000 inputs per decoder in CI; worker heap read through CDP before and after.

**Benchmarks** (F124): streaming scenarios added to `npm run bench` (frame-time percentiles, time to first complete frame, tiles, requests, wasted bytes, GPU and RAM bytes), stored under `benchmarks/results/<device>/` with the commit and compared with the previous run of the same device; CI gates only the deterministic counters (duplicate downloads, request counts, zero steady-state allocations).

## 5. Risks and open questions

Each item states the recommended decision, with PLAN.md's order of priorities: glitch-free first, then performance.

1. **Strict file order versus increments.** `CLAUDE.md` says to work only on the Next feature; most M3 features share machinery. Recommendation: start each increment from Next and mark every feature whose steps pass when it is done. The order in section 1 keeps Next advancing.
2. **One draw per tile versus texture pages (F103).** ADR 0010's switch depends on a WebGL2 CPU measurement on the reference desktop, and F075 waits for the owner's hardware. Recommendation: ship per-tile draws with the slot abstraction, define F103's budget in counts (section 3), measure three.js CPU time per draw on SwiftShader as a trend, and decide the switch on hardware before M3 closes or record it as pending.
3. **Merge transitions couple selection and transitions.** Children must stay drawn until their fade to the parent's data ends. Recommendation: a "retiring" flag per drawn tile that the traversal honors, bounded by T, with frame-stepped golden tests; this is where pops and holes are most likely, so it gets the most unit tests.
4. **Main-thread mesh bursts.** A jump creates hundreds of meshes at about 50 µs each, and r186's vertex-array release (KB-021) scans the whole cache per destroyed buffer. Recommendation: the mesh budget of section 3 with the parent-stays rule, eviction paced by ADR 0007's limits, and a benchmark of eviction cost; the r187 upgrade required before M4 removes the scan.
5. **Worker file in Vite dev from TypeScript sources.** `new URL('./vibeglobe-worker.js', import.meta.url)` must resolve to the `.ts` entry in dev and to the built file in `dist`. Recommendation: verify Vite's `.js`-to-`.ts` resolution for worker URLs in 3a; if it fails, the playground maps the path in its Vite plugin, and the integration guide records the `optimizeDeps.exclude` need (ADR 0011).
6. **KTX2 toolchain.** The transcoder needs a pinned Emscripten build and the fixtures a pinned `basisu`. Recommendation: build both in a pinned container image with committed hashes, nightly rebuild compared by hash (ADR 0020); time-box it in increment 6 and continue with F105 if it blocks, noting the reason in `progress.md`.
7. **When `ready` resolves.** Recommendation: after the whole pinned base is resident (no hole when zooming out, F084), and measure F115 against it; only if the 1 s target fails, resolve at the first frame covered by levels 0–1 while class 0 continues, through an ADR update.
8. **Pinned share with several base sources.** ADR 0007 says "1/8 of the GPU budget" for levels of "each base source". Recommendation: 1/8 in total across base sources, filled coarse first, so adding a source never doubles the pinned memory.
9. **Corrupt versus undecodable.** ADR 0007 lists "a format the browser cannot decode" as no data and corrupt payloads as quarantined. Recommendation: a content type the source does not declare, or a decoder the browser lacks, is no data; bytes of a declared format that fail to decode are corrupt (`failed`, one `tile-error` with reason `corrupt`, F112).
10. **Frames while loading.** PLAN.md says draw while anything loads. Recommendation: wake by events (section 2.3) rather than drawing identical frames while waiting on the network; the picture is the same, and battery use is lower. `idle` keeps waiting for pending loads.
11. **HTTP/2 certificate.** Recommendation: commit a clearly named test-only certificate and key for `localhost` (not a credential; it secures nothing), rather than depending on `openssl` at test time.
12. **Playground imagery.** No real Mercator dataset exists before M9. Recommendation: the `natural-earth` fixture pyramids for the default view and `world`/`levels` patterns for tests; this keeps canonical views recognizable and the bundled image the only source.
13. **Baseline churn.** Three increments change the picture. Recommendation: group visual changes into those increments and record baselines once per increment in the pinned environment, never from the container's Chromium 141.

## 6. Inconsistencies to resolve in increment 0

- `api.md` describes `RendererBackend` as `createTexture`, `createMesh`, `render(FrameDescription)` and `readPixels`; the code has `addMesh`, `removeMesh`, `setBaseImagery`, `render(view, keys, count)` and `capture()`. Section 2.2 is the M3 target; `api.md` follows it.
- `api.md` has `TilingScheme.tilesAt(position)` and `tileExtent(coord, GeoRectangle)`; the code has `tileAt(longitudeRad, latitudeRad, level, out)`, `TileRectangleRad` and `maxLatitudeRad`.
- `architecture.md` §6 says the packed key adds the root "above" the quadtree index and gives a one-root formula; `packTileKey` stores `index × 3 + root` (the root is the lowest digit) for pyramids of up to two root tiles.
- ADR 0010 §6 requires worker-decoded bitmaps, `flipY = false` and image-oriented UVs; M2 uploads an `HTMLImageElement` flipped by three.js with northward v.
- ADR 0006 measures `τ` in render-target pixels; M2's `maxScreenErrorPx` is in CSS pixels.
- ADR 0012 names a magenta sentinel clear color; the engine clears to transparent and the tests check the page background. Transparency is the stronger sentinel and should be written into ADR 0012.
- F101 and F103 cite draw-call, state-change and frame budgets "defined in docs/internal/plan"; `quality.md` has no draw-call or state-change budget yet (section 3 proposes them).
