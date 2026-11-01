# @vibeglobe/models

glTF 2.0 models (F361, ADR 0121): GLB and glTF parsing and validation, Draco and meshopt decoding in workers, node transforms, and a renderer-neutral `ModelDescription` (flat typed arrays, PBR materials as numbers, encoded images) that the renderer turns into GPU meshes.

## Rules

- No DOM and no rendering library: the renderer consumes `ModelDescription`; this package never imports three.js.
- Every byte is untrusted: validate before reading, bound sizes (`ModelLimits`), and fail only with a `ModelError` (code in `errors.ts`); the corruption tests fuzz this.
- Decoders (Draco through `draco3d`, meshopt through `meshoptimizer`) load lazily, only for models that need them, inside the worker task (`createModelTasks`); the main thread only fetches files (`createModelLoader`).
- Owned by the models and quality track (docs/internal/parallel-tracks.md, track C).

## Commands

- `npx vitest run packages/models` runs this package's tests; the Khronos samples in `src/__fixtures__/khronos/` (licenses in its README) drive the conformance suite.
- `npm run build` (root) builds it with `tsc -b` to `dist/` (ESM + declarations).

See the root `CLAUDE.md` for the workflow and `docs/internal/plan/architecture.md` for where this package fits.
