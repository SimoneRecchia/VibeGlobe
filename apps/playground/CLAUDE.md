# Playground

Demo app that exercises every engine feature; also the bed for visual, scenario and performance tests.

## Rules

- URL parameters drive it in tests: `?backend=webgpu|webgl2`, `?scenario=<name>`, `?debug=1`, `?network=online|offline|hybrid`.
- The page must load without console errors (`e2e/playground.spec.ts`).
- Workspace packages resolve to their TypeScript sources through the `source` export condition (`vite.config.ts`).

## Commands

- `npm run dev` (root) serves it at http://localhost:5173 (`PLAYGROUND_PORT` to change).
- `npm run test:e2e` (root) runs the Playwright tests against it.
