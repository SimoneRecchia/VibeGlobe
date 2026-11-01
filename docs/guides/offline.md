---
title: Offline packages
---

# Offline packages

`@vibeglobe/offline` keeps tiles in browser storage, reads offline packages, and decides per tile whether the network
may be used. `createOffline` makes the engine that wraps sources, `createPackageManager` installs and reads packages,
and `createManifest` writes a package's manifest. Sources come from `@vibeglobe/sources` ([sources guide](sources.md));
serving packages and tile folders is in the [hosting guide](hosting.md).

## Quick start

```ts
import { createOffline } from '@vibeglobe/offline';
import { xyzImagery } from '@vibeglobe/sources';

const offline = createOffline();
const imagery = offline.source(xyzImagery({ id: 'osm', url: 'https://tiles.example.com/{z}/{x}/{y}.png' }));
// Pass `imagery` to createGlobe({ imagery: [imagery], … }) like any other source.
const request = imagery.request({ root: 0, level: 3, x: 4, y: 2 }, { url: '', hostIndex: 0 });
if (typeof request !== 'object') throw new Error('the tile should exist');
await new Promise((done) => imagery.transport.start(request, { firstByteMs: 10_000, totalMs: 10_000 }, done));
if (offline.stats('osm').network !== 1) throw new Error('the first tile comes from the network');
if (offline.stats('osm').networkBytes === 0) throw new Error('its bytes are counted too');
offline.destroy();
```

A wrapped source keeps its id, levels and coverage; pass it to `createGlobe` instead of the original.

## How tiles are found

The engine's GPU and RAM memory come first. Below them a wrapped source takes each tile from the first tier that holds
it: the persistent cache, then the offline packages, then the network, each allowed or not by the network mode and the
switches. Downloads fill the persistent cache. `offline.stats(sourceId?)` counts the tiles each tier delivered
(`persistent`, `revalidated`, `package`, `network`, `offlineMisses`) and their bytes (`persistentBytes`,
`revalidatedBytes`, `packageBytes`, `networkBytes`).

Tiles that reach the engine without the tiers, such as a vector style's loaded by `addVectorTiles`, count in the same
statistics through `offline.countTransport(fetchTransport(), classify)`: pass the returned transport as the style's
`transport`. `classify(url)` returns the request's `sourceId`, its `tier` and optionally its `coord`, or `undefined`
for requests not to count (glyphs, sprites). Only delivered tiles count.

## Network modes

| Mode               | Reads packages | Touches the network                                    |
| ------------------ | -------------- | ------------------------------------------------------ |
| `hybrid` (default) | yes            | yes: packages give an instant base, the network detail |
| `online`           | never          | yes                                                    |
| `offline`          | yes            | never, not even health checks (air-gapped sites)       |

```ts
import { createOffline } from '@vibeglobe/offline';

const offline = createOffline({ mode: 'online' });
offline.setMode('offline');
if (offline.settings().mode !== 'offline') throw new Error('the mode did not change');
offline.destroy();
```

- New requests follow a mode change at once.
- `setMode(mode, { sourceId })` or `setMode(mode, { layerId })` gives one source or layer its own mode. A layer's mode
  beats its source's, which beats the global one; `'inherit'` drops an own mode. `offline.modeOf(sourceId, layerId?)`
  reads the mode in effect.
- In offline mode a tile no tier holds reads as no data. When a change takes sources out of offline mode, the
  `mode-change` event names them in `sourceIds`; reload each so the missed tiles load and every drawn tile stays:
  `offline.on('mode-change', ({ sourceIds }) => sourceIds.forEach((id) => globe.reloadSource(id, { missingOnly: true })))`.

## Loading switches

Four switches, all on by default: `persistentCache`, `memoryReuse`, `prefetch` (flight preloading included) and
`offlinePackaging`. Each is set globally, per source or per layer, at runtime. The effective value is on only when the
global value, the layer's, the source's and the provider's profile all allow it.

```ts
import { createOffline } from '@vibeglobe/offline';

const offline = createOffline({ switches: { prefetch: false } });
offline.setSwitches({ persistentCache: false }, { sourceId: 'live-traffic' });
const traffic = offline.effectiveSwitches('live-traffic');
if (traffic.persistentCache || traffic.prefetch || !traffic.offlinePackaging) throw new Error('unexpected switches');
offline.destroy();
```

- `offline.source(source)` reads the source's `profile`: its `forbids` stay off for that source. Switching a forbidden
  feature on leaves it off and emits one `warning` with code `profile-rule`.
- A profile that names only a credit (a `CreditProfile`, such as `xyzImagery`'s `profile` option) forbids nothing.
  Apply a `ProviderProfile` with `withProfile` of `@vibeglobe/sources` to have its `forbids` enforced.
- `offline.source(source, { rules })` replaces the source's profile with `rules` (any `ProviderProfile`).
- `{ layerId }` names the layer the source belongs to, for per-layer switches and modes (default: the source id).
- `{ tiers: 'package' }` serves the source only from the cache and packages, never the network; `'network'` never
  reads packages.

## Cache freshness

A stored tile is reused while its `Cache-Control` or `Expires` headers allow. A tile without such headers is reused for
24 hours (`DEFAULT_HEURISTIC_MAX_AGE_MS`), or revalidated every time when its profile has `respectCacheHeaders: true`.
`offline.source(source, { cachePolicy: { maxAgeMs } })` only shortens these times. Expired tiles are revalidated with
`If-None-Match` and `If-Modified-Since` on the page's own origin and downloaded again elsewhere (`revalidation`).
`no-store` responses are never written.

## Offline setup 1: a server on the local network

A plain HTTP server on the local network serves the site, its engine assets, packages and tile folders; the browsers
have no internet. The repository's
[LAN server](https://github.com/SimoneRecchia/VibeGlobe/blob/main/packages/offline/lan-server/lan-server.sh) needs
only Docker and sends the headers the engine needs (MIME types, CORS, cache headers, range requests):

```sh
packages/offline/lan-server/lan-server.sh --site apps/playground/dist --packages ./packages --tiles ./tiles --port 8080
```

`addServedPackage(manifestUrl)` reads a package in place, without installing it. The package manager opens PMTiles and
MBTiles files with the adapters you pass it; give `mbtilesImagery` the URL where you host `sql-wasm.wasm` of `sql.js`:

```ts
import { createOffline, createPackageManager } from '@vibeglobe/offline';
import { pmtilesImagery } from '@vibeglobe/sources';
import { mbtilesImagery } from '@vibeglobe/sources/mbtiles';

const offline = createOffline({ mode: 'hybrid' });
const packages = createPackageManager(offline, {
  adapters: {
    pmtiles: (options) => pmtilesImagery(options),
    mbtiles: (options) => mbtilesImagery({ ...options, wasmUrl: '/sql-wasm.wasm' }),
  },
});
const rome = await packages.addServedPackage('https://lan.example/packages/rome/manifest.json');
if (rome.id !== 'rome') throw new Error('the package was not read');
packages.destroy();
offline.destroy();
```

Health checks then target only the endpoints of your sources and packages, so the engine never waits on unreachable
internet hosts. A served package needs per-chunk checksums (`chunkSha256`, written by `createManifest`).

## Offline setup 2: everything in the browser

Install packages into browser storage while online; afterwards the engine runs from them and from the persistent cache
with no network. Installs report progress, resume after the page was closed (the next install of the same version
skips what was stored), and verify every chunk against the manifest's SHA-256.

```ts
import { createOffline, createPackageManager } from '@vibeglobe/offline';
import { pmtilesImagery } from '@vibeglobe/sources';
import { mbtilesImagery } from '@vibeglobe/sources/mbtiles';

const offline = createOffline();
const packages = createPackageManager(offline, {
  adapters: { pmtiles: (o) => pmtilesImagery(o), mbtiles: (o) => mbtilesImagery({ ...o, wasmUrl: '/sql-wasm.wasm' }) },
});
let progress = 0;
await packages.install('https://lan.example/packages/rome/manifest.json', {
  onProgress: (p) => (progress = p.loadedBytes / p.totalBytes),
});
const [installed] = await packages.list();
if (progress !== 1 || installed?.id !== 'rome') throw new Error('the package was not installed');
await packages.remove('rome');
packages.destroy();
offline.destroy();
```

A local file works too: `packages.install({ manifest: manifestFile, files: { 'rome.pmtiles': pmtilesFile } })`.
`install` also takes `signal` to cancel.

## Building packages

A package is PMTiles or MBTiles files with a JSON manifest: id, version, area, sources with levels, license and
attribution, and files with their SHA-256 and per-chunk SHA-256. Build the file with the data pipeline's CLI, then
write its manifest with `createManifest`:

```sh
npx vibeglobe-data pack --source 'https://tiles.example.com/{z}/{x}/{y}.png' --profile <profile> \
  --bbox 12.40,41.82,12.58,41.97 --zooms 0-8 --out rome.pmtiles --yes
```

`--polygon <file>` takes a GeoJSON Polygon instead of `--bbox`, `--format mbtiles` writes MBTiles (default PMTiles),
and `--estimate-only` stops after the estimate. `vibeglobe-data licenses` lists the profiles `--profile` accepts; the
CLI refuses a profile whose terms forbid packaging.

```ts
import { createManifest } from '@vibeglobe/offline';

const file = await (await fetch('https://lan.example/packages/rome/rome.pmtiles')).blob();
const manifest = await createManifest({
  id: 'rome',
  version: '2026-10-22',
  area: { westDeg: 12.4, southDeg: 41.82, eastDeg: 12.58, northDeg: 41.97 },
  sources: [
    {
      sourceId: 'osm',
      file: 'rome.pmtiles',
      minLevel: 0,
      maxLevel: 8,
      license: 'ODbL-1.0',
      attribution: { text: '© OpenStreetMap contributors' },
    },
  ],
  files: [{ path: 'rome.pmtiles', format: 'pmtiles', data: file }],
});
if (manifest.files[0]?.sha256.length !== 64) throw new Error('no checksum');
```

- `sourceId` must equal the id of the source the application wraps: the package serves that source's tiles.
- `area` is a box (`westDeg`, `southDeg`, `eastDeg`, `northDeg`) or a polygon (`{ polygonDeg: [[lon, lat], …] }`).
- Chunks are 1 MiB by default (`chunkBytes`).

The in-browser builder downloads an area of sources straight into browser storage:
`packages.install({ id, version, area, minLevel, maxLevel, sources: [{ source, license, attribution, rules?, layerId? }] })`
resolves with the installed package and its `report`. `packages.estimate(request)` counts the tiles first and
downloads nothing. The build stops before any download with `packaging-disabled` when `offlinePackaging` is off
globally, and with `packaging-forbidden` when a source's `rules` forbid packaging. A source whose effective
`offlinePackaging` is off (its switch, or the profile of the wrapped source with the same id) is left out and named
in `report.excluded`.

`packages.update(id)` installs the newest version from the package's manifest URL and deletes the old version's tiles;
it returns the installed package when the version is unchanged. A running globe drops the tiles it holds in memory
when the manager tells it which sources changed:

```ts
import { createOffline, createPackageManager } from '@vibeglobe/offline';
import { pmtilesImagery } from '@vibeglobe/sources';
import { mbtilesImagery } from '@vibeglobe/sources/mbtiles';

// A stand-in for the running globe, recording what the manager tells it.
const reloaded = new Array();
const globe = { reloadSource: (id = '') => reloaded.push(id) > 0 };
const offline = createOffline();
const packages = createPackageManager(offline, {
  adapters: { pmtiles: (o) => pmtilesImagery(o), mbtiles: (o) => mbtilesImagery({ ...o, wasmUrl: '/sql-wasm.wasm' }) },
  onChange: ({ sourceIds }) => sourceIds.forEach((id) => globe.reloadSource(id)),
});
await packages.install('https://lan.example/packages/rome/manifest.json');
await packages.remove('rome');
if (reloaded.join() !== 'osm,osm') throw new Error('the globe was not told which source changed');
packages.destroy();
offline.destroy();
```

## Storage quotas and persistence

The persistent cache keeps at most `cacheBytes` (512 MiB by default) and evicts the least recently used tiles beyond
it. When the browser's quota is reached, the write is refused, older tiles are evicted, one `warning` with code `quota`
is emitted, and the engine keeps working from memory, packages and the network. When the browser deletes stored data,
`storage-lost` says what was lost (`cache`, `packages`, `reason`).

```ts
import { createOffline, createPackageManager } from '@vibeglobe/offline';

const offline = createOffline({ cacheBytes: 64 * 1024 * 1024 });
offline.on('storage-lost', (event) => console.info('lost', event.cache, event.packages));
const packages = createPackageManager(offline);
const usage = await packages.storageUsage();
if (usage.totalBytes !== usage.cacheBytes + usage.packages.reduce((sum, p) => sum + p.bytes, 0))
  throw new Error('inconsistent storage use');
const persistence = await offline.requestPersistentStorage();
if (!['granted', 'denied', 'unsupported'].includes(persistence.status)) throw new Error('unexpected answer');
packages.destroy();
offline.destroy();
```

Browsers may evict best-effort storage under pressure (Safari after seven days without a visit).
`requestPersistentStorage()` asks the browser to keep it and reports whether it did. `offline.clearCache(sourceId?)`
empties the cache of one source or all of them.

## Options

`createOffline(options)`:

| Option         | Type                                      | Default               | Effect                                                 |
| -------------- | ----------------------------------------- | --------------------- | ------------------------------------------------------ |
| `mode`         | `'hybrid' \| 'online' \| 'offline'`       | `'hybrid'`            | the global network mode                                |
| `switches`     | `Partial<LoadingSwitches>`                | all on                | the global loading switches                            |
| `store`        | `CacheStore \| 'main-thread' \| 'memory'` | IndexedDB in a worker | where the persistent cache lives                       |
| `cacheBytes`   | `number`                                  | 512 MiB               | size limit of the default persistent cache             |
| `policy`       | `NetworkPolicy`                           | built in              | replaces the resolution of mode, switches and profiles |
| `healthChecks` | `HealthCheckTiming`                       | built in              | timing of the connectivity checks                      |
| `fetch`        | `typeof fetch`                            | global `fetch`        | used for tiles and health checks                       |
| `onServe`      | `(event: ServeEvent) => void`             | none                  | called for every tile delivered, with its tier         |

`createPackageManager(offline, options)` takes `adapters` (PMTiles and MBTiles readers), `onChange`,
`onIntegrityError`, `fetch`, and `indexedDB`, `database` and `localStorage` for tests.

## Rules and pitfalls

- Only sources wrapped by `offline.source()` go through the tiers and obey the switches and the profile's `forbids`;
  the engine prefetches and keeps tiles in memory for every other source.
- The default store runs IndexedDB in the module worker `@vibeglobe/offline/cache-worker.js`, which the bundler
  emits. Where it cannot start (no bundler, a Content Security Policy), pass `store: 'main-thread'`; the engine emits
  `storage-unavailable` and keeps rendering without a persistent cache otherwise.
- `store: 'memory'` keeps nothing across sessions: for kiosks and shared machines.
- Packages of terrain or vector tiles need adapters that accept any content:
  `pmtiles: (o) => pmtilesArchive(o, 'any')` and `mbtiles: (o) => mbtilesArchive(o, 'any')`. `pmtilesImagery` and
  `mbtilesImagery` read raster packages only.
- Without `adapters` the manager cannot read package files, and their tiles read as missing.
- Corrupted or unreadable package data reads as missing, and `onIntegrityError` names the package.
- In offline mode the engine touches no host at all; tiles no tier holds stay missing until the mode changes.
- `destroy()` both the package manager and the offline engine when the globe goes away: they hold workers and
  database connections.

## Errors

The package manager rejects with a `PackageError`: a stable `code` and a message naming the package, file or source.

| Code                  | When                                                                                  | What to do                                      |
| --------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `invalid-manifest`    | the manifest is not valid; a local file is missing; a served file has no chunk hashes | rebuild it with `createManifest`                |
| `download-failed`     | the manifest, a file or a tile could not be downloaded                                | check the URL and CORS, then install again      |
| `integrity`           | a file's size or a chunk's SHA-256 does not match the manifest                        | rebuild the manifest or download the file again |
| `not-installed`       | `update` or `remove` of a package that is not installed                               | check `list()`                                  |
| `packaging-disabled`  | the in-browser builder while `offlinePackaging` is off globally                       | switch it on, or do not build                   |
| `packaging-forbidden` | the in-browser builder with a source whose `rules` forbid packaging                   | leave that source out                           |

The offline engine emits `warning` events (`quota`, `storage-unavailable`, `profile-rule`) once per kind and never
throws for them.

## See also

- [Sources and adapters](sources.md): adapters, provider profiles and `withProfile`.
- [Hosting](hosting.md): MIME types, CORS and range requests for packages and tile folders.
