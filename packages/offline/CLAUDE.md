# @vibeglobe/offline

Persistent cache stores, network modes and loading switches, offline packages and their management API, connectivity and bandwidth estimation.

## Rules

- Offline-only mode never touches the network, health checks included. A provider profile can only switch features off.

## Commands

- `npm test` (root) runs this package's tests; tests sit next to the code as `*.test.ts`.
- `npm run build` (root) builds it with `tsc -b` to `dist/` (ESM + declarations).

See the root `CLAUDE.md` for the workflow and `docs/plan/architecture.md` for where this package fits.
