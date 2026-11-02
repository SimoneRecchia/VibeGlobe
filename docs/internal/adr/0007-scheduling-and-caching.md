# 0007. Tile request scheduler and memory caches

- Status: Accepted
- Date: 2026-10-20
- Milestone: M3

## Context

`PLAN.md` (Tiles, level of detail and streaming; Engineering standards) requires prioritized requests (screen center first, coarse before fine, visible before prefetch), concurrency limits per host and per provider profile, cancellation of requests no longer needed (essential during flights), retries with backoff, timeouts, no-data handling that never retries endlessly, request coalescing, never downloading the same tile twice, per-frame upload budgets, GPU and RAM budgets with LRU eviction, and a pinned base that is never evicted. `docs/internal/plan/quality.md` sets the numbers: uploads ≤ 2 ms and ≤ 8 MB per frame, GPU 512/256 MB and RAM 256/128 MB (desktop/tablet), 0 duplicate downloads per session, first complete frame ≤ 1 s from a LAN base, main-thread CPU ≤ 6 ms p95 per frame. The feature list makes the budgets hard ("never exceeded", F098) and requires declared rate limits (F222) and low concurrency for OpenStreetMap's public servers (F265).

The [scheduling and caching survey](../research/scheduling-and-caching.md) studied CesiumJS, MapLibre GL JS, OpenLayers, Leaflet, loaders.gl, 3DTilesRendererJS, iTowns and Potree. Its findings drive this decision:

- Most stalls in their issue trackers come from in-flight counters that leak on an unusual exit path (openlayers#6969, #3889, #16838; Leaflet#3002) or from silent admission refusals when a cache is full (3DTilesRendererJS#1689, #1722, #428, #1230).
- Wasted downloads come from requests that cannot be aborted (`<img>` loading: openlayers#15293) or are not aborted (maplibre#2577).
- Gating the network on frame time starves slow devices (openlayers#17682: 3.0 s → 0.4 s to fill the view once the limits were raised).
- None of the projects has request timeouts; only iTowns has backoff (fixed, without jitter).
- Destination preloading is missing for globe terrain and imagery in CesiumJS (#7987) and MapLibre (#116), and is valuable where it exists.

`docs/internal/plan/architecture.md` §7 describes the scheduler (binary heap, per-host and per-profile limits, `AbortController` cancellation, exponential backoff with jitter, timeouts, coalescing, upload budget); it is not marked Proposed. This ADR confirms it and amends it on the points listed under Consequences.

## Options considered

1. **Global bounded heap, re-requested every frame (CesiumJS).** A small heap (20) plus global and per-server caps; requests that do not fit are refused and asked again next frame; priorities re-evaluated once per frame. Pros: stateless callers, simple. Cons: refused requests and cancellations churn (about a third of 3D Tiles requests cancelled during flights, cesium#5509); slots refill only once per frame, which idles connections on fast links; globe tiles bypass the heap, so priority lives in three separate queues; no timeouts, no backoff.
2. **FIFO sorted once, browser-level throttling (MapLibre GL JS, Leaflet).** Tiles queued in center-distance order at selection time, with a global cap (MapLibre 16) or none (Leaflet). Pros: minimal code. Cons: the order goes stale during motion; no per-host or per-profile limit; requests queued inside the browser cannot be reprioritized; no retry or timeout.
3. **Persistent queue re-prioritized with drops, per-origin queues, slot tokens (OpenLayers, 3DTilesRendererJS, loaders.gl, iTowns).** Pros: priorities follow the camera; unwanted queued work drops for free; per-origin limits (3DTilesRendererJS, iTowns). Cons, as implemented: no abort in flight (OpenLayers, iTowns, loaders.gl); frame-time gating (OpenLayers); counter leaks; a full-list sort per eviction pass (3DTilesRendererJS); cache-full refusals that stall.
4. **Memory policy options.** Tile-count LRU (CesiumJS globe, MapLibre, OpenLayers, iTowns): cannot honor byte budgets. Byte LRU with an overflow allowance and memory-adjusted error (CesiumJS 3D Tiles, loaders.gl): keeps loading but breaks the budget. Byte LRU that refuses when full (3DTilesRendererJS): honors the budget but stalls. Subtree eviction by points (Potree).
5. **Chosen: option 3's queue model with Cesium's frame-marker LRU, plus what none of them has.** That is: aborts with a grace period, timeouts, jittered backoff as an eligibility gate, key-based coalescing across layers and instances, hard byte budgets kept by reserving predicted sizes and coarsening the selection, and immediate slot refill. Details below.

## Decision

**Structure.** Scheduling policy lives in `@vibeglobe/core` (no DOM types: core defines a minimal abort-signal interface that sources bridge to `AbortController`). Each engine instance has one `TileScheduler`. A page-wide `NetworkPool`, created lazily and reference-counted like the worker pool, owns host slots, rate limits and in-flight coalescing, so per-host and provider-profile limits hold across instances. When a slot on a host frees, the pool grants it to the instance whose best queued request for that host has the lowest key.

**Records and queue.** Each tile request is a pooled record (state, key, priority, host, attempts, next-eligible time, consumer count, abort handle) stored in preallocated typed arrays. Every frame the selection stamps each wanted tile with the frame number and a priority. The scheduler then rebuilds a binary heap of eligible queued records (linear heapify), drops queued records not stamped this frame, and dispatches. When a request settles, the freed slot is refilled at once, in a microtask, from the existing heap rather than at the next frame. The steady state allocates nothing; update cost must be ≤ 0.3 ms p95 with 5,000 wanted tiles.

**Priority key** (lower is sooner): `class × 1024 + level + w · d`.

- `class`: 0 pinned base, 1 visible, 2 flight destination, 3 flight path (including the current view during a flight), 4 prefetch.
- `level`: for an imagery request of a visible tile (its cover included, KB-305), a rank that falls by one for each level the request lies above the level the tile wants, in place of the level itself: every part of a view gains a level at the same pace, so a view whose tiles want different levels does not sharpen one part at a time (KB-330).
- `d` ∈ [0, 1]: the screen distance of the tile from the focus point (the screen center, or the cursor during anchored zoom), normalized to the farthest viewport corner.
- `w` = 2 (tuned in M3).
- A tile wanted by several consumers takes the best key.
- Requests carry the fetch `priority` hint: high for classes 0–1, low for class 4.

**Concurrency.** Defaults, all overridable per source:

- 6 in flight per host;
- 16 per host for hosts declared HTTP/2 or HTTP/3 or detected as such where Resource Timing exposes it;
- 32 in flight overall;
- provider-profile caps (OpenStreetMap public servers: the low value fixed by the M7 profile ADR);
- token-bucket rate limits from source metadata.

The scheduler never passes the browser more than these caps. The network is never gated on frame time; main-thread smoothness is protected by the decode and upload budgets instead. Backpressure: when decoded-but-not-uploaded bytes exceed 64 MB, dispatch of classes 2–4 pauses. M8 adapts per-host limits within these caps from the bandwidth and latency estimate.

**Cache hierarchy before network.** A dispatch first looks up the cache tiers in order (M3: RAM; M8 adds persistent storage and packages) and goes to the network only on a miss. Coalescing key = source id + tile key + variant (pixel ratio, format). One request serves every consumer; it is aborted only when none wants it any more.

**Cancellation.** All network loads use `fetch` with an abort signal (no `<img>` loading).

- Queued records not wanted this frame are dropped.
- In-flight requests not wanted for 2 consecutive frames and at least 100 ms are aborted.
- Decode tasks of unwanted tiles are removed from the worker queue, or cancelled cooperatively if already running ([ADR 0011](0011-workers.md)); pending uploads of unwanted tiles are dropped. Their downloaded bytes stay in the RAM tier, so nothing is fetched twice.

Abort, completion, failure, timeout and disposal all release the slot through one `finally` path owned by the scheduler; tile state listeners never touch counters. A cancelled tile returns to `unloaded`.

**Failures and timeouts.** Each failure is classified.

- No data, terminal: 404, 410, an empty 204, out of declared coverage, or a format the browser cannot decode. The key is recorded in a bounded per-source negative set (100,000 keys) that outlives evicted records.
- Transient: 408, 429, 500, 502, 503, 504, network errors and timeouts.
  - Retries are allowed only while the tile is wanted and the clock has passed `nextEligible = now + random(0, min(30 s, 0.5 s × 2^attempt))`. `Retry-After` is honored up to 60 s.
  - After 4 retries the tile is `failed` until the source reloads or connectivity recovers (M8). Its ancestor stays drawn, and one typed `tile-error` is emitted.
  - A 429 halves the host limit (minimum 1); it grows back by 1 every 20 successes.
  - After 5 consecutive transient failures, a host is limited to 1 probe request until a success.
- Authorization (401, 403): no tile retry; a source-level error lets the profile refresh credentials (Google session tokens) and reload.
- Corrupt payload: quarantined, never retried.

Timeouts are 10 s to response headers and 30 s in total, per source configurable; M8 adapts them from observed latency.

**Memory.** GPU and RAM budgets are hard caps with exact byte accounting: texture texels × bytes per texel × 4/3 for mipmaps, plus buffer lengths; encoded byte lengths plus a fixed overhead per record.

- **Tiers.** The RAM tier holds encoded bytes; every GPU-resident tile keeps its encoded bytes in RAM, used to rebuild GPU resources after context or device loss by decoding again. Evicting a tile's RAM entry evicts its GPU copy too. Decoded copies (`ImageBitmap`, typed arrays) are transient and released right after upload.
- **LRU order.** An intrusive doubly linked LRU over the pooled records. Selection touches tiles in post-order, so a parent is always more recent than its children and children are evicted first. A frame marker excludes everything used this frame.
- **Protected tiles.** The pinned base, the render set (including fallback ancestors and fading tiles) and tiles with pipeline work in progress are never evicted.
- **Trimming.** Eviction starts when usage exceeds the budget or an admission needs room, and goes down to 90%. Outside admissions it does at most 64 tiles or 1 ms of work per frame.
- **Admission.** Predicted bytes (known for imagery from the tile size and format; a running mean per source for meshes) are reserved at dispatch and reconciled on arrival. If evicting unprotected tiles cannot make room, the tile is refused and counted (`refused`), a trace event is emitted, and the selection's error multiplier rises ×1.05 per frame (cap ×4) until the working set fits; it relaxes ÷1.02 per frame below 80% usage. A debounced `memory-pressure` event is emitted. The view keeps drawing resident ancestors, so nothing goes black and the budget is never exceeded.
- **Memory reuse off.** Every unprotected tile is evicted at the end of the frame.
- **WebGPU out-of-memory.** On WebGPU, allocations are sampled in `out-of-memory` error scopes; an error triggers eviction to 75% and lowers the budget by 25% for the session.

**Pinned base.** Levels 0..N of each base imagery and terrain source, with N the deepest level whose cumulative GPU size fits in 1/8 of the GPU budget (at least levels 0–1). It is loaded first (class 0), before refinement starts. Context recovery restores it first. Creation fails with a clear error if levels 0–1 do not fit.

**Uploads.** A priority-ordered upload queue is drained each frame within 2 ms and 8 MB, predicted from a per-backend cost model (an exponentially weighted moving average of bytes per millisecond, measured on every upload). Items larger than the byte budget are uploaded in slices (rows or mip levels) across frames by the renderer.

**Observability and idle.** Per-frame counters, also shown in the debug overlay:

- queued, in flight per host, dispatched, coalesced;
- dropped while queued, aborted in flight, retries, timeouts, failures, no data, refused;
- bytes downloaded and wasted (aborted or never used);
- cache hits per tier, upload time and bytes, GPU and RAM bytes.

Trace events cover the request lifecycle (F121). `idle` fires only when nothing is queued, in flight, decoding, uploading or fading, and nothing was refused. Otherwise the engine exposes why it is not complete (memory pressure, failed tiles, offline). In tests, a watchdog fails the run if a host has free slots while eligible requests wait for more than 2 frames, or if an in-flight request outlives its timeout by 1 s.

## Consequences

- **Changes to `docs/internal/plan/architecture.md`.**
  - §2 says instances share only the worker pool and the persistent cache store; this ADR adds the network pool (host slots, rate limits, in-flight coalescing) to the shared set.
  - §9 says loss recovery rebuilds from "CPU-side caches"; this ADR specifies them: encoded bytes in the RAM tier, decoded again in workers, pinned base first.
  - §6 says failed tiles "retry with backoff"; the backoff is an eligibility gate applied only while the tile is wanted, not a timer.
  - These documents are updated when M3 starts. Everything else in §6–§8 is confirmed.
- **Easier.** A single key space orders imagery, terrain, vector tiles and later 3D Tiles (F462). Flight preloading (M8) only adds classes 2–3 from a second selection pass with the destination and sampled path cameras. Bandwidth adaptation (M8) only adjusts per-host limits, timeouts and prefetch depth within the caps defined here. Budgets hold by construction.
- **Harder.**
  - Every source must load through `fetch` and therefore needs CORS (already required for textures).
  - Byte accounting needs exact size formulas per resource type.
  - The post-order touch rule couples the selection and the cache.
  - The shared pool needs cross-instance tests.
- **Follow-up work.**
  - M3: measure and tune the defaults listed in the survey: per-host limit, abort grace, center weight `w`, upload cost model, eviction pacing, pinned size.
  - M7: range merging for PMTiles and Cloud Optimized GeoTIFF in the adapters; the OpenStreetMap profile limit.
  - M8: adaptive limits and timeouts, persistent tiers, flight preloading.
  - M13: check that 3D Tiles do not starve the globe.
- **Verification.**
  - Unit and property-based tests with a fake transport and a fake clock. Invariants: per-host and global caps never exceeded; every slot released exactly once; no key fetched twice concurrently; an unwanted record is dropped or aborted within the grace period; retry times stay inside the jitter bounds (seeded random generator); no-data is never retried; protected tiles are never evicted; the budget is never exceeded; zero allocations in steady state.
  - Playwright scenarios against a fixture server with latency, bandwidth, failure and HTTP/1.1 and HTTP/2 controls, with request logs. They cover jump, fast pan, globe-to-street zoom, the Milan to Tokyo path, and chaos (10% 503 responses, 5% stalls, 1% corrupt payloads). They assert zero duplicate downloads, bounded wasted bytes, no watchdog stall, zero black pixels, upload budget per frame (F101) and first complete frame ≤ 1 s (F115).
  - Benchmarks record scheduler update cost and frame-time distribution in `benchmarks/results/`.
