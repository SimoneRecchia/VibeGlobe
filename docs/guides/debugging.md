# Debugging and observability

What the engine and the playground offer to see what a globe is doing (M3, F116–F121).

## Debug overlay (`?debug=1`)

The playground's overlay shows the backend and GPU limits, frame time and frame rate, draw calls and pipeline switches, the surface selection, and the imagery caches: RAM hits and misses, requests in flight, GPU and RAM memory against their budgets (F117). Its values are those of `Globe.imageryStats()`, `Globe.rendererStats()` and `Globe.surfaceStats()`.

The **Tile view** checkbox outlines every drawn surface tile and labels it with its level (`L5`), its geometric screen-space error in pixels (`SSE 0.8`) and the source of its imagery (`fixture-levels L4`, or `base` for the world base image). Tiles drawn from an ancestor's imagery are outlined in orange and dashed (F116). The view is a separate canvas over the globe: unchecking it removes it and leaves the globe's frames untouched.

## Phase timing and performance marks

`globe.setPhaseTiming(true)` measures each frame's phases: `update` (input and camera), `selection` (the surface quadtree), `scheduling` (imagery wants, requests and the worker queue), `upload` (textures within the per-frame budget) and `render`. While it is on, each phase is also a User Timing measure named `vibeglobe:<phase>`, visible in the browser's performance panel (F118), and `globe.phaseTimesMs()` returns the last frame's durations. It is off by default and then costs one branch per phase.

## Performance HUD

`?hud=1` in the playground (or `showHud(true)` from the test hooks) shows frame time, frame rate and the per-phase costs, refreshed twice a second (F119). It turns phase timing on. **Documented overhead:** at most 0.5 ms of main-thread time per frame on the software GPU of CI; `e2e/observability.spec.ts` checks it.

## Logging

`GlobeOptions.logLevel` (`debug`, `info`, `warn`, `error`, `silent`; default `warn`) and `globe.setLogLevel()` filter the engine's messages; `GlobeOptions.logSink` receives `{ level, message, timeMs }` instead of the console (F120). Messages: `debug` for each tile request, `info` when the engine starts, `warn` when a tile fails for good, `error` for a device that cannot be recovered.

## Event traces

`globe.startTrace()` records tile state changes, requests (start, end, cancel, failure) and camera moves with their engine-clock times in a ring buffer of plain objects; `globe.stopTrace()` returns them, ready for `JSON.stringify` (F121). Off, nothing is recorded and nothing is allocated.
