# 0029. Offline storage, packages and network modes

- Status: Accepted
- Date: 2026-10-22
- Milestone: M8 (offline track, `packages/offline`)

## Context

`PLAN.md` (Offline, online and caching) asks for a tier order GPU → RAM → persistent browser storage → offline
packages → network, three network modes, loading switches that a provider profile can only switch off, quotas,
eviction awareness, versioned and verified packages, and connectivity detection that recognizes captive portals.
`docs/plan/architecture.md` §8 left the storage backend (IndexedDB or OPFS) and the package format to this milestone.
The survey is [`docs/research/offline-and-network.md`](../research/offline-and-network.md).

The offline track plugs into the frozen source contract (`docs/parallel-tracks.md`) and may not edit core: the
engine's GPU and RAM tiers stay as M3 built them, and everything below them happens inside a source's transport.

## Options considered

1. **Storage: IndexedDB, OPFS or the Cache API.** IndexedDB works in every target browser including Safari, holds
   ArrayBuffers and Blobs with metadata and indexes (needed for LRU), and can run in a worker. OPFS is fast only through
   synchronous handles in workers, needs its own index for metadata and LRU, and Safari's support is younger. The Cache
   API is keyed by `Response`, has no metadata or LRU index and accounts sizes opaquely (survey, failure modes).
2. **Where the tiers live: in core's loader, or in a transport wrapper.** Core owns the loader, so the offline track
   cannot add tiers there; a wrapper around a source's transport sees every request the loader makes, knows the tile
   coordinate (the wrapper's `request()` encodes it in the URL it hands out) and keeps the frozen contract.
3. **Package format: PMTiles only, PMTiles and MBTiles, or a custom format.** PMTiles is one file read with range
   requests, which suits both offline setups; MBTiles is common and supported by the M7 adapters. A custom format would
   need its own tooling.
4. **Integrity: whole-file hash, per-chunk hashes, or format checks only.** A whole-file SHA-256 catches any corruption
   but only after reading everything; per-chunk hashes let reads verify only what they touch and name the damaged part.

## Decision

- **Tiers in a transport wrapper.** `Offline.source(source)` returns the source with a transport that tries, per tile:
  the persistent cache (fresh entries), the offline packages, then the network, as the `NetworkPolicy` allows, and
  writes downloads back to the cache. An expired entry is served when the network cannot answer. Package tiles are not
  copied into the persistent cache: the package is already persistent.
- **Persistent cache in IndexedDB inside a dedicated cache worker** (`workerStore`, `cache-worker.js`); `'main-thread'`
  and `'memory'` stores and custom `CacheStore`s are options (F327). Tiles are ArrayBuffers; a separate index store
  holds size and last access, so a read rewrites no tile bytes and eviction walks an index (least recently used first,
  down to 90% of the limit, default 512 MiB). A `QuotaExceededError` evicts a quarter, answers `'quota'`, and the
  engine logs one warning; rendering continues from memory and network. Opening the database has a 10 s time limit.
- **Eviction awareness.** The `close` and `versionchange` events of an open database report a loss while the page is
  open; a localStorage note of what should exist (cache filled, packages and versions) reports losses between sessions.
  Both raise `storage-lost`.
- **Cache policy from HTTP headers.** `no-store` is never persisted; `max-age`/`s-maxage`, `no-cache` and `Expires`
  set freshness; responses without freshness headers are reused for 24 hours unless the provider requires its headers
  to be respected; per-source `maxAgeMs` can only shorten. Expired tiles are revalidated with `If-None-Match` and
  `If-Modified-Since` on the page's own origin (or when a source opts in), and by a plain refetch with an ETag
  comparison elsewhere, because those headers trigger a CORS preflight that tile hosts often refuse.
- **Packages are PMTiles or MBTiles files with a JSON manifest** (id, version, sources with levels, license and
  attribution, area, files with size, SHA-256 and per-chunk SHA-256; `createManifest`). Installed packages are stored in
  1 MiB chunks in IndexedDB; installs resume by skipping stored chunks; each chunk is checked on install and on read,
  the whole file on install, and the PMTiles header layout names the damaged part (header, directories, metadata, tile
  data). A read that reaches a damaged chunk ends before it, so tiles elsewhere still load; damaged tiles read as
  missing and the engine keeps their ancestors. Packages on a LAN server are read in place with the same checks
  (offline mode 1). Archives are opened through the M7 PMTiles and MBTiles adapters, passed in by the application.
  Packages built in the browser from an area, a zoom range and sources store their tiles individually with a SHA-256.
  A new version is committed before the old one is deleted.
- **Modes and switches.** Online only never reads packages, offline only never touches the network (no health checks),
  hybrid uses both. Switches are global, per source and per layer; the effective value is
  `global ∧ layer ∧ source ∧ profile allows`. A provider profile that forbids packaging makes the build fail before
  any download.
- **Connectivity from health checks** against each endpoint's coarsest tile: a redirect, an HTML page served as a
  success, a 5xx or no answer means unreachable (an HTML error page is an answer). A failed tile request triggers a
  check; checks back off from 2 s to 60 s and never run more than once per endpoint per interval; `online`/`offline`
  events only trigger checks. A failed download waits up to 3 s for the check it triggered: if the endpoint is
  unreachable the failure never reaches the engine (whose host probing would otherwise let one request through at a
  time, slowing cached and packaged tiles too); if it is reachable the engine gets the failure and backs off. While an
  endpoint is unreachable, a tile no tier holds is held for 500 ms and handed back as an abort, so the engine asks
  again later without spending its retries and loads it once connectivity returns. In offline-only mode such a tile
  is no data.

## Consequences

- Memory reuse, prefetch and flight preloading act in core's loader; the switches are stored and resolved here, and core
  reads them once the hooks in `docs/parallel-tracks.md` exist. Until core can invalidate a source's memory tiers, a
  new package version reaches tiles already in GPU or RAM memory only after the globe is recreated.
- A tile that became no data in offline-only mode stays so in that globe after switching to hybrid (core treats no
  data as final); the hook request for a source reload covers it.
- A start with no reachable data for the pinned coarse levels (no world package, no cache, network down) shows the
  base image but keeps `Globe.ready` pending until connectivity returns, because held tiles never settle; a hybrid
  setup installs a low-detail world package, which settles them. A transport result that counts as settled for
  `ready` is requested from core.
- Verified by `packages/offline/src/*.test.ts` (fake IndexedDB) and the browser specs `e2e/offline-*.spec.ts`.
