# @vibeglobe/renderer

`RendererBackend` implementation: WebGPU with automatic WebGL2 fallback, shaders, GPU resource management, upload budget, device and context loss recovery.

## Rules

- three.js (ADR 0010) is imported only here, from `three/webgpu` and `three/tsl`, pinned to exactly `three@0.186.1`. Globe logic (tiles, levels of detail, precision, camera) stays in core.
- Every feature must render the same on WebGPU and on forced WebGL2 (the playground's `?backend=` switch arrives with this package's first code in M2).

## Commands

- `npm test` (root) runs this package's tests; tests sit next to the code as `*.test.ts`.
- `npm run build` (root) builds it with `tsc -b` to `dist/` (ESM + declarations).

See the root `CLAUDE.md` for the workflow and `docs/plan/architecture.md` for where this package fits.
