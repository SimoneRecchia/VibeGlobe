# @vibeglobe/core

Framework-agnostic heart of the engine: math, WGS84 geodesy, projections and morph, camera and view modes, tiling and level of detail, request scheduler, memory cache, loading policy, events, the `createGlobe` facade and every plug-in interface.

## Rules

- No runtime dependencies and no DOM: `tsconfig.json` has no DOM lib, so `window`, `document` and GPU APIs do not type-check here. Browser APIs arrive through plug-ins at runtime.
- Angles are radians internally and degrees in the public API; distances are meters. Put the unit in the name when it could be ambiguous.
- Per-frame code allocates nothing: reuse preallocated `Float64Array`s and pooled objects. Hot-path modules are `*.hot.ts` with a `@hotpath` / `@benchmark` header (`npm run check`).
- Coverage of this package is enforced at 90% lines (`npm run coverage`).

## Commands

- `npm test` (root) runs this package's tests; tests sit next to the code as `*.test.ts`.
- `npm run build` (root) builds it with `tsc -b` to `dist/` (ESM + declarations).

See the root `CLAUDE.md` for the workflow and `docs/plan/architecture.md` for where this package fits.
