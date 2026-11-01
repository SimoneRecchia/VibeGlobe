---
title: Debugging and observability
---

# Debugging and observability

What `@vibeglobe/core` offers to see what a globe is loading and drawing: leveled logging, counters, phase timing and
event traces through `Globe.diagnostics`. `@vibeglobe/ui` shows the main figures in a panel (`DebugToggleControl`),
and `@vibeglobe/core/diagnostics` has `FrameStats` for frame times of your own. Everything is off or quiet by default
and then costs one branch.

## Quick start

```ts
import { createGlobe } from '@vibeglobe/core';

const globe = createGlobe({
  container,
  renderer,
  baseImageryUrl: '/vibeglobe/fallback-base.jpg',
  logLevel: 'info',
  logSink: ({ level, message, timeMs }) => console.log(level, timeMs, message),
});
await globe.ready;
console.log(globe.backend, globe.surfaceStats(), globe.rendererStats());
```

## Logging

`GlobeOptions.logLevel` sets the quietest level logged: `'debug'`, `'info'`, `'warn'` (default), `'error'` or
`'silent'`; `globe.diagnostics.setLogLevel(level)` changes it at runtime. `GlobeOptions.logSink` receives each
`LogEntry` (`level`, `message`, `timeMs` of the engine clock) in place of the console, where messages carry the prefix
`[vibeglobe]`.

| Level   | Messages                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------- |
| `debug` | Each imagery tile request, with its priority                                                      |
| `info`  | The engine started, with its backend                                                              |
| `warn`  | A tile failed for good; the engine could not start or recover; a required credit cannot be hidden |
| `error` | A source with invalid metadata (left out); a tile server without CORS headers; a reported error   |

## Counters

| Method                   | What it returns                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `globe.surfaceStats()`   | The last frame's surface tiles: drawn, deepest level, culled, from an ancestor, on base |
| `globe.surfaceTiles()`   | Each surface tile of the last frame: level, bounds, screen errors, imagery level        |
| `globe.imageryStats()`   | Imagery streaming and caches: requests, hits, GPU and RAM against their budgets         |
| `globe.terrainStats()`   | Terrain streaming: queued, loading, ready, failed, uploads                              |
| `globe.rendererStats()`  | Draw calls, triangles, texture uploads, pipeline compiles                               |
| `globe.resourceCounts()` | GPU meshes and textures held, all zero after `destroy()`                                |
| `globe.capabilities`     | The device's backend and limits, after `ready`                                          |

`imageryStats()` and `terrainStats()` are undefined without imagery or terrain, and before the renderer starts.

## Phase timing

`globe.diagnostics.setPhaseTiming(true)` times each frame's phases, in order: `update` (input and camera),
`selection` (the surface quadtree), `scheduling` (tile wants, requests and the worker queue), `upload` (textures
within the frame's budget) and `render`. `globe.diagnostics.phaseTimesMs()` returns the last timed frame's durations,
and `FRAME_PHASES` lists the names. Each phase is also a User Timing measure `vibeglobe:<phase>` in the browser's
performance panel; `setPhaseTiming(true, false)` leaves the measures out. Timing with a live readout costs at most
0.5 ms of main-thread time per frame.

## Event traces

`globe.diagnostics.startTrace()` records tile state changes (`queued`, `ready`, `failed`, `evicted`), requests
(`start`, `end`, `cancel`, `fail`) and camera moves, with their engine-clock times; `stopTrace()` returns the events,
oldest first, as plain objects ready for `JSON.stringify`. The trace keeps the newest 20,000 events. While no trace
runs, nothing is recorded or allocated.

```ts
import type { Globe } from '@vibeglobe/core';

declare const globe: Globe;

globe.diagnostics.startTrace();
await globe.flyTo({ longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 12 });
const trace = globe.diagnostics.stopTrace();
console.log(JSON.stringify(trace.filter((event) => event.kind === 'request')));
```

## The debug panel

`DebugToggleControl` of `@vibeglobe/ui` adds a button that shows a panel with the frame time and rate, the backend,
the surface tiles, draw calls and the imagery cache, refreshed four times a second while shown.
`addDefaultControls(ui, { debug: true })` adds it. For a panel of your own figures, `createDebugOverlay(container)`
returns an overlay with `update({ frameTimeMs, framesPerSecond })` and `setInfo(rows)`, and `FrameStats` of
`@vibeglobe/core/diagnostics` computes frame times and rates over a window.

## See also

- [UI and GIS](ui-and-gis.md): adding controls and theming the panel (`--vg-ui-debug-*`).
- [Integration](integration.md#errors): the errors an application handles.
