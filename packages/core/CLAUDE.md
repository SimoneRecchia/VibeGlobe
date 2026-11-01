# @vibeglobe/core

Framework-agnostic heart of the engine: math, WGS84 geodesy, projections and morph, camera and view modes, tiling and level of detail, request scheduler, memory cache, loading policy, events, the `createGlobe` facade and every plug-in interface.

## Rules

- No runtime dependencies and no DOM: `tsconfig.json` has no DOM lib, so `window`, `document` and GPU APIs do not type-check here. Browser APIs arrive through plug-ins at runtime.
- Angles are radians internally and degrees in the public API; distances are meters. Put the unit in the name when it could be ambiguous.
- Per-frame code allocates nothing: reuse preallocated `Float64Array`s and pooled objects. A new field on a class the frame loop writes (`GlobeEngine`, `SurfaceFrame`, `DrawList`) can change its V8 layout so that its per-frame writes allocate: keep new state elsewhere (a module-level `WeakMap`, a prototype getter) and run `frame-allocation.test.ts` a few times. Hot-path modules are `*.hot.ts` with a `@hotpath` / `@benchmark` header (`npm run check`).
- Coverage of this package is enforced at 90% lines (`npm run coverage`).
- The main entry is within about 0.1 KB of its 65 KB budget as CI measures it (see the root `CLAUDE.md`): measure every change with `npm run size`.
- `AtmosphereSettings` grows only with a rule in `engine-quality.ts` (`ATMOSPHERE_RULES`) and a default next to the others; the renderer receives every field (`Required<AtmosphereSettings>`). `dayNight` and `airlight` (F647) are 0 to 1.
- `camera.zoom` and `constraints.minZoom` / `maxZoom` are Web Mercator zooms at the view center's latitude; `constraints.maxRangeMeters` (F646) is the latitude-free far limit.

## Commands

- `npm test` (root) runs this package's tests; tests sit next to the code as `*.test.ts`.
- `npm run build` (root) builds it with `tsc -b` to `dist/` (ESM + declarations).

See the root `CLAUDE.md` for the workflow and `docs/internal/plan/architecture.md` for where this package fits.
