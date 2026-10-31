# 0122. Quality presets, start-up choice and adaptive quality

- Status: Accepted (decided by agent; owner may revisit)
- Date: 2026-10-23
- Milestone: M11

## Context

`PLAN.md` asks for presets (low, medium, high, ultra) controlling detail, resolution scale and effects, switchable at
runtime without a glitch (F399); a start-up preset from capability detection that applications can override (F400);
and adaptive quality that lowers detail or resolution when the frame rate drops (F401) and raises it back with
hysteresis so it never oscillates (F402). The models and quality track builds this in a new package that drives the
globe only through its public API (`docs/parallel-tracks.md`, track C). Prior art studied for the approach (not
copied): CesiumJS's `maximumScreenSpaceError` and `resolutionScale`, Unity's and Unreal's dynamic resolution (frame
time over a window, step changes, a dead band), three.js's `PerformanceMonitor` pattern in react-three-drei
(average over a window with upper and lower bounds and a flip-flop counter).

## Options considered

1. **Continuous controller** (a PID on resolution scale every frame). Smooth in theory; in practice it reacts to
   noise, changes the drawing buffer size every frame (each resize reallocates targets) and is hard to bound.
2. **Discrete ladder with a governor.** A short list of levels per preset; the governor steps one level at a time on
   a median over a window, with separate thresholds, timers and a minimum interval. Predictable and testable.

## Decision

Option 2, in `@vibeglobe/quality`:

- **Presets** (`QUALITY_PRESETS`): low (resolution 0.5, screen error 4 px, anisotropy 1, no anti-aliasing, low
  atmosphere, no fog), medium (0.75, 2 px, 4, FXAA, medium), high (1, 1 px, device maximum, MSAA 4×, high), ultra
  (1.25, 0.75 px, device maximum, MSAA 4×, ultra).
- **Start-up choice** (`choosePreset`, first rule wins): low for a software renderer, ≤ 2 GiB memory, a largest
  texture under 4096 or ≤ 2 processors; medium for the WebGL2 fallback, ≤ 4 GiB, ≤ 4 processors or a coarse
  pointer (the reference tablet); high otherwise (the reference desktop). Ultra only on request. An explicit preset
  overrides detection.
- **Ladder** (`adaptiveLadder`): from the preset, alternate resolution × 0.85 and screen error × 1.4 down to 0.4 and
  8 px; effects stay (switching them would show, and they cost little next to pixels and tiles).
- **Governor** (`FrameTimeGovernor`): median of the last 30 frame intervals; lower one step when it stays above
  target × 1.15 for 500 ms; raise one step when it stays under target × 0.75 for 3 s; at most one change per 2 s;
  a raise undone by the next lowering doubles the next raise's wait (up to 8×); gaps over 250 ms (idle, hidden tab)
  restart the measurement. Reaction time: the window plus 500 ms (1.25 s at 25 ms frames). Target 60 fps by default.
- **Controller** (`createQuality(globe, { preset, adaptive })`): measures the interval between `frame` events,
  applies the resolution through `Globe.setResolutionScale` and the rest through a `setQualitySettings` hook the
  engine adds (hook request); changes apply between frames and request a redraw.

## Consequences

- Until the engine implements `setQualitySettings`, presets and adaptation change only the resolution scale; level of
  detail, anti-aliasing, anisotropy and atmosphere follow once the hook lands (`docs/parallel-tracks.md`).
- Frame time from frame intervals measures what the user sees (CPU or GPU bound, vsync included); GPU timestamp
  queries are not required.
- Verified in Node by `governor.test.ts` (reaction, step-by-step recovery, a 5-minute load hovering at the
  threshold, backoff), `startup.test.ts` (emulated and reference profiles), `quality.test.ts` (runtime switching,
  override, adaptation through the resolution scale) and in Chromium by `e2e/quality.spec.ts`.

## Amendment 2026-10-31: weak devices and 60 Hz screens

Found in the code review of 2026-10-31. Two cases the governor above could not handle:

- **A 60 Hz screen never raised quality again.** The display never draws faster than the 60 fps target, so the
  median never got under target × 0.75 and one slow spell (tiles arriving) left quality lowered for the session. The
  governor now also tries a raise once frames hold the target (median at most 5 % over it) for `probeMs` (12 s). A
  tried raise that makes frames slow is undone, and the undo doubles the next try's wait like any other (up to 8×), so
  a device at its limit tries at most every 96 s.
- **A device drawing under 4 frames a second never adapted.** Every frame was longer than the 250 ms gap that restarts
  the measurement, so the window never filled. The gap is now 2 s, and the controller also restarts the measurement on
  the engine's `idle` event, which tells it when the engine stopped drawing on purpose.
- **Dense screens drew far more pixels than the preset meant.** The resolution scale multiplies the device pixel
  ratio, so a phone at 3 drew 2.25 pixels per CSS pixel on `medium`, about five times a ratio-1 screen's. Each preset
  now caps the pixels per CSS pixel (`maxPixelRatio`: low 1, medium 1.5, high 2, ultra none), against the device
  pixel ratio at the controller's start; at ratio 1 to 1.5 nothing changes.
