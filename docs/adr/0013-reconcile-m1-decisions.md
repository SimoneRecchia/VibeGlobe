# 0013. Reconcile the M1 decisions

- Status: Accepted
- Date: 2026-10-20
- Milestone: M1 (applies to M2–M5)

## Context

The nine M1 research surveys were written in parallel, and the milestone review found points where their ADRs disagree with each other or with the plan. Later milestones need one answer for each. This ADR settles them; where it overrides part of an earlier ADR, that ADR's status says so.

## Options considered

For each conflict, the options were the positions of the ADRs involved:

1. **Near and far planes.** ADR 0005: infinite far plane, near plane from the camera clearance, no fitting. ADR 0008: near and far planes fitted to the morphed surface, with the far plane capped at the horizon distance to hide the antimeridian cut on the flat map.
2. **Polar caps on the flat map.** ADR 0006 §7: the flat map does not draw the caps. ADR 0008: the caps continue on the flat map as a strip beyond ±85.0511°, which feature F154 requires.
3. **Terrain geometry.** ADR 0006 §5: every source rasterized to height grids, vertex buffers shared per grid and heights read in the vertex shader. ADR 0008: per-tile buffers holding globe and plane offsets. ADR 0010: one shared grid per resolution, per-tile buffers for quantized-mesh. ADR 0011: workers return per-tile meshes for both morph targets. ADR 0004 forbids GPU trigonometry for positions, so a vertex shader cannot turn a shared grid plus heights into globe positions.
4. **Renderer events.** `docs/plan/api.md` and the feature list (F063): `device-lost`, `device-restored`. ADR 0010: `renderer-lost`, `renderer-restored`, `renderer-failed`, `backend-fallback`.
5. **Tile keys.** ADR 0006 adds two geographic polar-cap roots to the Web Mercator quadtree; the plan's packed key has no root.
6. **ADR 0012's M1 probes** (determinism, backend consistency and capture cost on Playwright's pinned Chromium in CI, `--deterministic-mode` pacing, one canonical view per backend) need a rendered frame, and the engine renders nothing before M2.
7. **Benchmark frame-time budget.** `quality/budgets.json` sets 18 ms for the p95 of `requestAnimationFrame` intervals, while the PLAN target is 16.7 ms.

## Decision

1. **ADR 0005 wins.** The far plane is infinite and never fitted. The antimeridian cut of the flat map (tiles placed at the longitude copy nearest the anchor, ADR 0008) is hidden by CPU culling: tiles farther than the morph-aware horizon distance are not drawn, which ADR 0008's far-plane cap did implicitly. ADR 0008's near/far fitting is superseded.
2. **ADR 0008 wins.** The flat map draws the polar caps as a strip beyond ±85.0511°. ADR 0006 §7's statement is superseded.
3. **Per-tile vertex buffers, shared index buffers.** Workers turn every terrain source into a height grid (ADR 0006), then build each tile's mesh as float32 globe and plane offsets from the tile's float64 origin (ADR 0004, ADR 0008, ADR 0011), with skirts sized from the two levels' geometric errors. Index buffers are shared per grid resolution. The time-based geomorph of ADR 0006 blends the previous and new offsets per vertex. ADR 0006 §5's shared vertex buffers and ADR 0010's shared-grid rule are superseded; RTIN-style simplification remains a measured fallback only.
4. **Public events follow the API and the feature list:** `device-lost` and `device-restored` (renderer recreated after a loss), `backend-fallback` (the WebGPU startup self-test failed and WebGL2 took over), and `error` with code `renderer-failed` after three failed recoveries in 60 s. ADR 0010's names are internal.
5. **Tile keys carry a root id:** `TileCoord` is `{ root, level, x, y }`, with root 0 for the Web Mercator quadtree and 1 and 2 for the north and south caps; the packed numeric key adds the root above the quadtree index.
6. **The probes move to M2**, where the renderer exists: they run in the CI job that adds the visual tests (F069, F071) and their results are recorded in ADR 0012's follow-up section of the M2 progress notes. The 0.01% same-backend tolerance stays provisional until then. Start-up time (navigation to `ready`) and steady-state allocation sampling also start in M2 with the engine's frame loop (F061); the M1 harness records them as unavailable.
7. **18 ms stays, for this reason:** rAF intervals are quantized to the display refresh and to the browser's 0.1 ms timestamp coarsening, so with no dropped frame a 60 Hz run still measures per-run p95 values of 16.7–16.8 ms (measured in M1). A 16.7 ms gate would fail on jitter alone; 18 ms fails as soon as more than 5% of frames miss a refresh. The PLAN target is checked on the reference devices in M15 with the same statistic, and any change to the budget goes through `docs/test-changes.md`.

## Consequences

- ADR 0005, 0006, 0008, 0010 and 0012 keep their status but are marked as partly superseded by this ADR (0012 for the timing of its probes); `docs/plan/` follows this ADR.
- M2 has three extra tasks: the ADR 0012 probes, start-up measurement and allocation sampling.
- Per-tile vertex buffers cost more memory than a shared grid; ADR 0007's GPU budget accounts for them, and M4 measures the cost against the budget.
