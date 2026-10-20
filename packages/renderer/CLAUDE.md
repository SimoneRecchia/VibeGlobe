# @vibeglobe/renderer

`RendererBackend` implementation: WebGPU with automatic WebGL2 fallback, shaders, GPU resource management, upload budget, device and context loss recovery.

## Rules

- The rendering library (ADR 0010) is imported only here, pinned to an exact version. Globe logic (tiles, levels of detail, precision, camera) stays in core.
- Every feature must render the same on WebGPU and on forced WebGL2 (`?backend=webgl2` in the playground).

## Commands

- `npm test` (root) runs this package's tests; tests sit next to the code as `*.test.ts`.
- `npm run build` (root) builds it with `tsc -b` to `dist/` (ESM + declarations).

See the root `CLAUDE.md` for the workflow and `docs/plan/architecture.md` for where this package fits.
