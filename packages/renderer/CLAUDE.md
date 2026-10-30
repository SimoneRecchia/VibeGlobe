# @vibeglobe/renderer

`RendererBackend` implementation: WebGPU with automatic WebGL2 fallback, shaders, GPU resource management, upload budget, device and context loss recovery.

## Rules

- three.js (ADR 0010) is imported only here, from `three/webgpu` and `three/tsl`, pinned to exactly `three@0.186.1`. Globe logic (tiles, levels of detail, precision, camera) stays in core.
- The space background (`src/starfield/`, its own entry `@vibeglobe/renderer/starfield`) is not part of the main entry's budget; its halo (`glow`, F643) is drawn by the Milky Way's full-screen backdrop, default 0 so the background looks as before.
- The surface material composes its imagery and overlay slots, then applies the atmosphere in the same `Fn`: an overlay with blend 3 (`'night'`, F647) is not mixed into the color but returned as light that `surfaceColor` adds on the night side. The day and night constants (terminator band, night tint) are in `atmosphere/atmosphere-model.ts`; with `dayNight` > 0 the atmosphere follows the real Sun for the shading (`daySun`) and blends the sky's Sun toward it.
- The main entry is within about 0.3 KB of its 40.5 KB budget (40.17 KB locally on 2026-10-31; CI measures a little more): run `npm run size` after shader changes, which are JavaScript too.
- Every feature must render the same on WebGPU and on forced WebGL2 (the playground's `?backend=` switch arrives with this package's first code in M2).

## Commands

- `npm test` (root) runs this package's tests; tests sit next to the code as `*.test.ts`.
- `npm run build` (root) builds it with `tsc -b` to `dist/` (ESM + declarations).

See the root `CLAUDE.md` for the workflow and `docs/plan/architecture.md` for where this package fits.
