# @vibeglobe/quality

Quality presets and adaptive quality (F399–F402, ADR 0122): the presets `low`, `medium`, `high` and `ultra` (level of detail, resolution scale and effects), the start-up choice from capability detection, and the frame-time governor with hysteresis that steps quality down and back up.

## Rules

- Drives a globe only through its public API (`QualityTarget`: `on('frame')`, `setResolutionScale`, `requestRender`, and the requested `setQualitySettings` hook); never imports core internals or the renderer.
- The governor is pure: it takes frame timestamps from an injected clock, so tests drive it frame by frame without real time.
- No DOM at import time: browser hints are read only when `createQuality` runs (`browserHints`).
- Owned by the models and quality track (docs/internal/parallel-tracks.md, track C).

## Commands

- `npx vitest run packages/quality` runs this package's tests; `e2e/quality.spec.ts` drives it on the real engine.
- `npm run build` (root) builds it with `tsc -b` to `dist/` (ESM + declarations).

See the root `CLAUDE.md` for the workflow and `docs/internal/plan/architecture.md` for where this package fits.
