# 0014. Frame-time classification and gates

- Status: Accepted
- Date: 2026-10-20
- Milestone: M1 (applies to every benchmark, through M15)

## Context

`PLAN.md` targets 60 fps with a 95th-percentile frame time of at most 16.7 ms on the reference desktop, and ADR 0012 reports, per run, the frames over 16.7 ms and over 33.3 ms. Frame times are `requestAnimationFrame` intervals, which are quantized to the display refresh and to the browser's 0.1 ms timestamp coarsening. The M1 milestone review found three inconsistent treatments of that jitter: ADR 0013 §7 gated at 18 ms, the harness counted frames as late beyond 16.7 + 0.5 ms but as two refreshes from 33.3 − 0.5 ms, and neither tolerance was recorded in an ADR.

Measurements before this decision (M1, Chromium 141 on SwiftShader, 60 Hz, `npm run bench`, five runs per scenario): on-time intervals measured 16.6–16.8 ms, per-run p95 16.7–16.8 ms, median of the per-run p95 16.70 ms; with the strict 16.7 ms comparison, 38–52 of about 180 on-time frames per run counted as late.

## Options considered

1. **Compare with the nominal thresholds (16.7 ms, 33.3 ms):** counts on-time frames as late and misses a dropped frame measured at 33.2999 ms; a 16.7 ms gate fails on jitter alone.
2. **A loose gate (18 ms):** passes, but tolerates far more than jitter and has no rule behind the number.
3. **One timer-jitter tolerance applied to every threshold:** a frame is late only beyond the jitter, and the gate keeps the PLAN target's meaning ("at least 95% of frames on time").

## Decision

Option 3, with a timer-jitter tolerance of 0.5 ms (four times the largest on-time deviation measured, and far below half a refresh even at 120 Hz):

- `over16_7` counts intervals longer than 16.7 + 0.5 = 17.2 ms: frames that missed at least one 60 Hz refresh.
- `over33_3` counts intervals longer than 33.3 + 0.5 = 33.8 ms: frames that missed at least two refreshes.
- The PLAN target "p95 ≤ 16.7 ms" and every frame-time budget are checked as: median of the per-run p95 ≤ 16.7 + 0.5 = 17.2 ms. `quality/budgets.json` sets 17.2 ms for the M1 scenarios.

This supersedes ADR 0013 §7 (the 18 ms gate). Measurements after the change: median p95 16.70 ms on both M1 scenarios, within 17.2 ms.

## Consequences

- One rule for every benchmark from M1 to the M15 reference-device pass; `docs/plan/quality.md` states it.
- A real regression of one dropped frame in twenty fails the gate; jitter does not.
- Displays at other refresh rates use the same thresholds, which stay conservative (at 120 Hz, a frame over 17.2 ms has missed at least one refresh).
