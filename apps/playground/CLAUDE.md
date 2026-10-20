# Playground

Demo app that exercises every engine feature; also the bed for visual, scenario and performance tests.

## Rules

- URL parameters drive it in tests. Today: `?debug=1` (debug overlay) and `?scenario=frame-loop` (benchmark frame loop). Each milestone adds its own (`?backend=webgpu|webgl2` with the renderer in M2, `?network=…` in M8) and documents it here.
- Tests and benchmarks read the page through `window.vgePlayground` (`src/test-hooks.ts`), never through private state.
- The page must load without console errors (`e2e/playground.spec.ts`).
- Workspace packages resolve to their TypeScript sources through the `source` export condition (`vite.config.ts`).

## Commands

- `npm run dev` (root) serves it at http://localhost:5173 (`PLAYGROUND_PORT` to change).
- `npm run test:e2e` (root) runs the Playwright tests against it; `npm run bench` (root) runs the benchmark scenarios on its production build.
