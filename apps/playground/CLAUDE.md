# Playground

Demo app that exercises every engine feature; also the bed for visual, scenario and performance tests.

## Rules

- URL parameters drive it in tests: `?backend=webgpu|webgl2`, `?depth=fragment` (forces WebGL2's fragment-written depth path, ADR 0005), `?lon=&lat=&zoom=&heading=&tilt=` (initial view), `?debug=1` (debug overlay) and `?scenario=` with `frame-loop` (benchmark frame loop), `two-globes` (two instances), `drag` (continuous drag for the `drag-*` benchmarks; `?level=` sets the coarsest surface level and so the tile count), `street-level-jitter` and `depth-range` (debug quads for F057 and F058, `src/scenarios.ts`). `?experiment=offscreen&render=main|worker` is the F065 measurement mode (`src/render-experiment/`, `npm run bench:offscreen`): the engine on the main thread or in a worker with OffscreenCanvas, with input, frame and overlay instrumentation. Later milestones add their own (`?network=…` in M8) and document them here.
- Tests and benchmarks read the page through `window.vibeglobePlayground` (`src/test-hooks.ts`), never through private state; its `mount()` creates and destroys extra instances for the leak suite.
- The page must load without console errors (`e2e/playground.spec.ts`).
- Workspace packages resolve to their TypeScript sources through the `source` export condition (`vite.config.ts`).

## Commands

- `npm run dev` (root) serves it at http://localhost:5173 (`PLAYGROUND_PORT` to change).
- `npm run test:e2e` (root) runs the Playwright tests against it; `npm run bench` (root) runs the benchmark scenarios on its production build.
