# @vibeglobe/gis

GIS utilities: coordinate formatting and parsing (decimal degrees, DMS, UTM), reference-system transforms through proj4js, geodesic measurement on core's geodesics, and view-state serialization to URLs and JSON.

## Rules

- Pure functions, no DOM and no engine instance: the ui package's readout, search box and measurement tools call them, and so can applications.
- Geodesy comes from `@vibeglobe/core` (Karney's geodesics); projections other than core's go through proj4js, with definitions kept in this package's registry, never proj4's global one.
- Owned by the UI and GIS utilities track (docs/parallel-tracks.md).

## Commands

- `npm test` (root) runs this package's tests; tests sit next to the code as `*.test.ts`.
- `npm run build` (root) builds it with `tsc -b` to `dist/` (ESM + declarations).

See the root `CLAUDE.md` for the workflow and `docs/plan/architecture.md` for where this package fits.
