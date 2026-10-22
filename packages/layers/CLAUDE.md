# @vibeglobe/layers

Application data layers: primitives, labels, styling expressions, clustering, picking, draping and ground clamping.

## Rules

- Single-feature updates patch GPU buffers in place; never rebuild a layer for one feature.
- Layers draw only through `LayerRenderTarget` (`src/render-target.ts`); tests use `RecordingRenderTarget`, which records every upload. three.js never appears here (ADR 0029).
- Styles are MapLibre Style Specification properties and expressions, compiled by `@maplibre/maplibre-gl-style-spec`; a missing property makes the style engine fall back to the default with a warning, which is slow, so test fixtures carry every property their style reads.
- Owned by the data-layers parallel track (`docs/parallel-tracks.md`): drawing, draping, clamping, terrain picking and glTF are the main session's.

## Commands

- `npm test` (root) runs this package's tests; tests sit next to the code as `*.test.ts`.
- `npm run build` (root) builds it with `tsc -b` to `dist/` (ESM + declarations).

See the root `CLAUDE.md` for the workflow and `docs/plan/architecture.md` for where this package fits.
