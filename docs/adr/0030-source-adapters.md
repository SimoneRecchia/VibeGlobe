# 0030. Source adapters on the frozen source contract

- Status: Accepted
- Date: 2026-10-22
- Milestone: M7 (source adapters track)

## Context

M7 needs adapters for WMTS, WMS, PMTiles, MBTiles, the vector formats (GeoJSON, KML/KMZ, GPX, MVT) and the Google and OpenStreetMap provider profiles, each with a conformance suite (`PLAN.md`, Sources; F223, F230–F239, F256–F267). A fourth session builds them in parallel with the main track against the source contract frozen on 2026-10-22 (`docs/parallel-tracks.md`): `ImagerySource` with a synchronous `request(coord, out)` that writes a URL, a `TileTransport` that never throws, and the Web Mercator and geographic tiling schemes. Survey: [source-adapters.md](../research/source-adapters.md).

## Options considered

1. **Extend the contract** (async `request`, metadata fields in core): the cleanest shape, but the contract is frozen and owned by the main track.
2. **Keep the contract and work around its gaps in `@vibeglobe/sources`:** async factories, adapter-owned transports behind pseudo URLs, extra metadata fields on the returned object.
3. **Download whole packages up front** (PMTiles, MBTiles) so `request` stays trivially synchronous: simple, but defeats range requests for large archives.

## Decision

Option 2:

- Adapters return `DescribedImagerySource`: the contract's fields plus `attribution` and `profile` (docs/plan/api.md `SourceMetadata`), which the engine reads when it builds credits (F254) and enforces profiles.
- Work that must happen before tiles exist (capabilities, archive headers, Google sessions) happens in an **async factory** (`await wmtsImagery(…)`), so levels, coverage and attribution come from the service itself.
- Per-tile asynchronous work happens in the adapter's **own transport** (`archiveTransport`): `request` writes a pseudo URL such as `https://host/archive.pmtiles#z/x/y` that keeps the host (per-host concurrency, request coalescing) and the transport resolves it. Errors map onto the contract's results: HTTP statuses stay statuses, a missing tile is a 404, a malformed archive or answer is an empty body (no data), never an exception.
- PMTiles uses the maintained `pmtiles` library with range requests; MBTiles uses `sql.js` and downloads the package once (local files and LAN servers), in its own entry point `@vibeglobe/sources/mbtiles` so SQLite stays out of the main bundle.
- WMTS and WMS request EPSG:3857 or EPSG:4326 directly when offered (F227); a tile matrix set is used only for the levels that match the engine's schemes exactly. Other reference systems are refused with a `needs-reprojection` `SourceConfigError` until the main track's reprojection (F226, F228) accepts them.
- WMS requests a 32 px gutter and crops it in the transport (`createImageBitmap` and `OffscreenCanvas`, off the main thread in current browsers), because the contract's decoder description has no crop parameter; XML service exceptions are permanent failures (status 400).
- Vector parsers are pure functions exposed as a worker task table (`VECTOR_TASKS` in `@vibeglobe/sources/vector`), returning GeoJSON-shaped features; problems are reported per feature. The MVT decoder is written for this repository (on `pbf`) because the maintained decoder accepts tiles the specification calls fatal.
- The conformance suites (`@vibeglobe/sources/conformance`) are framework-free functions that return their checks, so a custom adapter package runs them unchanged.

## Consequences

- The main track can integrate the adapters without contract changes; when it adds metadata, async requests or a crop parameter to the contract, the workarounds above shrink (listed in `docs/parallel-tracks.md`).
- MBTiles packages are held in memory once downloaded; very large packages over a LAN are a follow-up (range reads of SQLite pages).
- Verified by the conformance suites in `packages/sources` and the browser tests `e2e/sources-*.spec.ts`.
