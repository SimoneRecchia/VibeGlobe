# @vibeglobe/offline

Persistent tile cache, network modes and offline packages. `createOffline` wraps sources so each tile comes from the
browser's storage, an installed or served package, or the network, as the network mode (`hybrid`, `online`,
`offline`), the loading switches and the provider's profile allow. `createPackageManager` installs, updates and reads
PMTiles and MBTiles packages; `createManifest` writes their manifests. An application needs it to keep tiles across
sessions, to run without internet, or to switch loading features off per source.

## Install

Needs `@vibeglobe/core`, `@vibeglobe/sources` and `@noble/hashes` (dependencies). Reading MBTiles packages also needs
`@vibeglobe/sources/mbtiles` and `sql-wasm.wasm` of `sql.js` hosted by the application.

## Entry points

| Import path                          | What                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| `@vibeglobe/offline`                 | `createOffline`, `createPackageManager`, `createManifest`, stores and policies |
| `@vibeglobe/offline/cache-worker.js` | The cache worker program of the default store, emitted by the bundler          |

## Example

```ts
import { createOffline, createPackageManager } from '@vibeglobe/offline';
import { pmtilesImagery, xyzImagery } from '@vibeglobe/sources';
import { mbtilesImagery } from '@vibeglobe/sources/mbtiles';

const offline = createOffline({ mode: 'hybrid' });
const imagery = offline.source(xyzImagery({ id: 'osm', url: 'https://tiles.example.com/{z}/{x}/{y}.png' }));
const packages = createPackageManager(offline, {
  adapters: { pmtiles: (o) => pmtilesImagery(o), mbtiles: (o) => mbtilesImagery({ ...o, wasmUrl: '/sql-wasm.wasm' }) },
});
await packages.install('https://lan.example/packages/rome/manifest.json');
// createGlobe({ imagery: [imagery], … }); later: packages.destroy(); offline.destroy();
```

## Pitfalls

- Only sources wrapped by `offline.source()` use the cache and packages and obey the switches and `forbids`.
- A profile that names only a credit (`xyzImagery`'s `profile` option) forbids nothing; use `withProfile` of
  `@vibeglobe/sources` for a full profile.
- The default store runs in a module worker the bundler emits; without a bundler pass `store: 'main-thread'`.
- A package's `sourceId` must equal the id of the wrapped source it serves.
- Terrain and vector packages need `pmtilesArchive(o, 'any')` and `mbtilesArchive(o, 'any')` as adapters.

## Guides

[Offline packages](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/offline.md),
[Hosting](https://github.com/SimoneRecchia/VibeGlobe/blob/main/docs/guides/hosting.md).
