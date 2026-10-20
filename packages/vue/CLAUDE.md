# @vibeglobe/vue

Vue 3 adapter: components and composables around the engine.

## Rules

- SSR-safe: create the engine only in `onMounted`; importing the package must never touch `window`, `document` or the GPU.
- The only package allowed to import Vue (`npm run check`).

## Commands

- `npm test` (root) runs this package's tests; tests sit next to the code as `*.test.ts`.
- `npm run build` (root) builds it with `tsc -b` to `dist/` (ESM + declarations).

See the root `CLAUDE.md` for the workflow and `docs/plan/architecture.md` for where this package fits.
