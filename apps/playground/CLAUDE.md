# Playground

Demo app that exercises every engine feature; also the bed for visual, scenario and performance tests.

## Rules

- URL parameters drive it in tests: `?backend=webgpu|webgl2`, `?lon=&lat=&zoom=&heading=&tilt=` (initial view), `?debug=1` (debug overlay) and `?scenario=` with `frame-loop` (benchmark frame loop), `two-globes` (two instances), `street-level-jitter` and `depth-range` (debug quads for F057 and F058, `src/scenarios.ts`). Later milestones add their own (`?network=…` in M8) and document them here.
- Tests and benchmarks read the page through `window.vibeglobePlayground` (`src/test-hooks.ts`), never through private state.
- The page must load without console errors (`e2e/playground.spec.ts`).
- Workspace packages resolve to their TypeScript sources through the `source` export condition (`vite.config.ts`).

## Commands

- `npm run dev` (root) serves it at http://localhost:5173 (`PLAYGROUND_PORT` to change).
- `npm run test:e2e` (root) runs the Playwright tests against it; `npm run bench` (root) runs the benchmark scenarios on its production build.
