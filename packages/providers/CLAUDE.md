# @vibeglobe/providers

Optional ready services for particular providers (ADR 0186), each a function returning plain data: `mapTilerTiles`,
`mapTilerTerrain`, `esriTiles`, `openFreeMapTiles`, `photonGeocoder`, and OpenStreetMap's public and hosted tiles.

## Rules

- Each provider is built only on the public API of `@vibeglobe/core` and `@vibeglobe/sources`; the engine never imports
  this package.
- Each provider's profile names the ADR where its terms were read; keys and tokens are the application's, passed as
  options; logs show them redacted (`redactUrl`).
- Tests run against fixtures and stubbed `fetch`, never against the providers' servers.

## Commands

- `npx vitest run packages/providers` runs this package's tests.
- `npm run build` (root) builds it with `tsc -b` to `dist/` (ESM + declarations).

See the root `CLAUDE.md` for the workflow and `docs/guides/services.md` for its use.
