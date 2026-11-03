# @vibeglobe/renderer

`RendererBackend` implementation: WebGPU with automatic WebGL2 fallback, shaders, GPU resource management, upload budget, device and context loss recovery.

## Rules

- three.js (ADR 0010) is imported only here, from `three/webgpu` and `three/tsl`, pinned to exactly `three@0.186.1`. Globe logic (tiles, levels of detail, precision, camera) stays in core.
- The GPU readback probes (`@vibeglobe/renderer/gpu-probes`, `src/run-gpu-probes.ts`) and the space background (`src/starfield/`, its own entry `@vibeglobe/renderer/starfield`) are not part of the main entry's budget; the space background's halo (`glow`, F643) is drawn by the Milky Way's full-screen backdrop, default 0 so the background looks as before.
- The surface material composes its imagery and overlay slots, then applies the atmosphere in the same `Fn`: an overlay with blend 3 (`'night'`, F647) is not mixed into the color but returned as light that `surfaceColor` adds on the night side. The day and night constants (terminator band, night tint) are in `atmosphere/atmosphere-model.ts`; with `dayNight` > 0 the atmosphere follows the real Sun for the shading (`daySun`) and blends the sky's Sun toward it.
- The main entry is 38.28 KB of its 38.5 KB budget (locally on 2026-11-03, after F694's motion blur; CI measures a little more): run `npm run size` after shader changes, which are JavaScript too. The size counts the main entry's lazy chunks (`fxaa.ts`), so an optional effect goes in an entry of its own that the application passes in, as `gltf` and `motionBlur` are.
- Motion blur (F694): `@vibeglobe/renderer/motion-blur` loads `motion-blur-pass.ts`, outside the main entry's budget, when `QualitySettings.motionBlur` first turns it on. `Antialiasing` draws a moving camera's frames through it (the scene pass of `fxaa.ts`, multisampled for `msaa4`) and still frames as without; every moving frame asks for one more (`contentReady`), so the last frame drawn is sharp.
- Every feature must render the same on WebGPU and on forced WebGL2 (the playground's `?backend=` switch arrives with this package's first code in M2).

## Commands

- `npm test` (root) runs this package's tests; tests sit next to the code as `*.test.ts`.
- `npm run build` (root) builds it with `tsc -b` to `dist/` (ESM + declarations).

See the root `CLAUDE.md` for the workflow and `docs/internal/plan/architecture.md` for where this package fits.
