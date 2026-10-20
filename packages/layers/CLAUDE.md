# @vibeglobe/layers

Application data layers: primitives, labels, styling expressions, clustering, picking, draping and ground clamping.

## Rules

- Single-feature updates patch GPU buffers in place; never rebuild a layer for one feature.

## Commands

- `npm test` (root) runs this package's tests; tests sit next to the code as `*.test.ts`.
- `npm run build` (root) builds it with `tsc -b` to `dist/` (ESM + declarations).

See the root `CLAUDE.md` for the workflow and `docs/plan/architecture.md` for where this package fits.
