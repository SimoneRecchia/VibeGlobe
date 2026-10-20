# @vibeglobe/sources

Source adapters (imagery, terrain, vector, 3D) behind the core `TileSource` interface, their worker decoders, reprojection and provider profiles.

## Rules

- Decoders run in workers and treat every byte as untrusted: validate, bound sizes, never throw past the adapter boundary (fuzz tests).
- Provider profiles only switch features off; record the reading of a provider's terms in an ADR.

## Commands

- `npm test` (root) runs this package's tests; tests sit next to the code as `*.test.ts`.
- `npm run build` (root) builds it with `tsc -b` to `dist/` (ESM + declarations).

See the root `CLAUDE.md` for the workflow and `docs/plan/architecture.md` for where this package fits.
