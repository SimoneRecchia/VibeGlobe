# vibeglobe

The public entry of VibeGlobe and its one published package (ADR 0186, ADR 0189): the release packs every other engine
package into it under subpaths (`scripts/release/tarballs.ts`). `createVibeGlobe(container, { tiles, terrain?,
geocoder?, … })` starts a globe with the application's services and wires the renderer, the workers, the navigation and
the ready-made controls.

## Rules

- No map and no provider here, nor anywhere in the library (ADR 0187): only the service interfaces of
  `@vibeglobe/core` (`TileService`, `TerrainSource`, `GeocoderService`); the application brings its own.
- `tiles` is required (refused with 'invalid-option'); a missing optional service only turns its feature off, never an
  error.
- What the first frame does not need loads later: the vector tile modules are imported only for a tile service with a
  style.

## Commands

- `npx vitest run packages/vibeglobe` runs this package's tests; `e2e/services.spec.ts` drives it in a browser.
- `npm run build` (root) builds it with `tsc -b` to `dist/` (ESM + declarations).

See the root `CLAUDE.md` for the workflow and `docs/internal/plan/architecture.md` for where this package fits.
