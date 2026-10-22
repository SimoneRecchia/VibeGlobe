---
title: Offline packages
---

# Offline packages

`@vibeglobe/offline` keeps tiles in browser storage, reads offline packages, and decides per tile whether the network
may be used. This guide covers network modes, loading switches, both offline setups, building packages, the package
management API, storage quotas and persistence. The design is recorded in ADR 0029.

Every `ts` example below runs as an end-to-end test (`e2e/offline-guide.spec.ts`), against the hosts named in it.

## How tiles are found

Wrap each source with `offline.source()`. A wrapped source looks for each tile in the engine's GPU and RAM memory,
then in the persistent cache, then in the offline packages, then on the network, and stores downloads on the way
back. `offline.stats()` counts where tiles came from.

```ts
import { createOffline } from '@vibeglobe/offline';
import { xyzImagery } from '@vibeglobe/sources';

const offline = createOffline();
const imagery = offline.source(xyzImagery({ id: 'osm', url: 'https://tiles.example.com/{z}/{x}/{y}.png' }));
// Pass `imagery` to createGlobe({ imagery: [imagery], … }) like any other source.
const request = imagery.request({ root: 0, level: 3, x: 4, y: 2 }, { url: '', hostIndex: 0 });
if (request === 'noData') throw new Error('the tile should exist');
await new Promise((done) => imagery.transport.start(request, { firstByteMs: 10_000, totalMs: 10_000 }, done));
if (offline.stats('osm').network !== 1) throw new Error('the first tile comes from the network');
offline.destroy();
```

## Network modes

| Mode               | Reads packages | Touches the network                                    |
| ------------------ | -------------- | ------------------------------------------------------ |
| `hybrid` (default) | yes            | yes: packages give an instant base, the network detail |
| `online`           | never          | yes                                                    |
| `offline`          | yes            | never, not even health checks (air-gapped sites)       |

The mode changes at runtime; new requests follow it at once.

```ts
import { createOffline } from '@vibeglobe/offline';

const offline = createOffline({ mode: 'online' });
offline.setMode('offline');
if (offline.settings().mode !== 'offline') throw new Error('the mode did not change');
offline.destroy();
```

## Loading switches

Four switches, all on by default: `persistentCache`, `memoryReuse`, `prefetch` (also flight preloading) and
`offlinePackaging`. Each can be set globally, per source or per layer, at runtime. The effective value is the global
one, and the layer's, and the source's, and what the provider's profile allows: a profile can only switch features
off.

```ts
import { createOffline } from '@vibeglobe/offline';

const offline = createOffline({ switches: { prefetch: false } });
offline.setSwitches({ persistentCache: false }, { sourceId: 'live-traffic' });
const traffic = offline.effectiveSwitches('live-traffic');
if (traffic.persistentCache || traffic.prefetch || !traffic.offlinePackaging) throw new Error('unexpected switches');
offline.destroy();
```

A source adapter's `profile` (for example the Google profile, which forbids persistent caching and packaging) is
read from the source; you can also pass rules yourself with `offline.source(source, { rules })`.

## Offline setup 1: a server on the local network

Packages and static tile folders are served by a plain HTTP server on the local network; the browser has no internet.
The repository's LAN server needs only Docker and serves a site build, its engine assets, packages and tile folders with
the headers the engine needs (MIME types, CORS, cache headers, range requests):

```sh
packages/offline/lan-server/lan-server.sh --site apps/playground/dist --packages ./packages --tiles ./tiles --port 8080
```

Read a package in place, without installing it, with `addServedPackage`. The package manager opens PMTiles and MBTiles
files with the adapters of `@vibeglobe/sources` you pass it; in a browser, give `mbtilesImagery` the URL of sql.js's
WebAssembly file (`wasmUrl`, `node_modules/sql.js/dist/sql-wasm.wasm` copied to your site):

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
internet hosts.

## Offline setup 2: everything in the browser

Install packages into browser storage while online; afterwards the engine runs from them and from the persistent cache
with no network at all. Installs report progress, survive the page being closed (the next install of the same version
resumes), and verify every chunk against the manifest's SHA-256.

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

## Building packages

Packages are PMTiles or MBTiles files with a JSON manifest (id, version, area, sources with levels, license and
attribution, files with their SHA-256 and per-chunk SHA-256). Build the file with the data pipeline's CLI, then write
its manifest with `createManifest`:

```sh
npx vibeglobe-data pack --source 'https://tiles.example.com/{z}/{x}/{y}.png' --profile <profile> \
  --bbox 12.40,41.82,12.58,41.97 --zooms 0-14 --out rome.pmtiles
```

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

The CLI refuses sources whose terms forbid packaging, and so does the in-browser builder, which downloads an area of
wrapped sources directly into browser storage: `packages.install({ id, version, area, minLevel, maxLevel, sources })`.
The build stops before any download when a provider forbids packaging; sources whose `offlinePackaging` switch is off
are left out and named in the build report.

A new version replaces the old one: `packages.update(id)` installs the newest version from the package's manifest URL
and deletes the old version's tiles. Recreate the globe (or reload the page) afterwards so tiles already in memory are
read again.

## Storage quotas and persistence

The persistent cache keeps at most `cacheBytes` (512 MiB by default) and evicts the least recently used tiles beyond
it. When the browser's quota is reached, writes are refused with one warning and the engine keeps working from memory,
packages and the network. When the browser deletes stored data, a `storage-lost` event says what was lost.

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

Browsers may evict best-effort storage under pressure (and Safari after seven days without a visit);
`requestPersistentStorage()` asks the browser to keep it and reports whether it did.
