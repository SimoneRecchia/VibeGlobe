---
title: The Europe preset
---

# The Europe preset

`@vibeglobe/presets` gives an application Google Earth-like map types of Europe built only from free sources whose
terms allow commercial use and redistribution: `europeOpen(options)`. It returns base maps (Satellite, Hybrid, Map,
Relief) and overlays (labels and borders, roads, 3D buildings, 3D terrain), each as a list of layers with
pre-configured sources: their URL, coverage, levels, licence, exact attribution and the day their terms were read
([ADR 0182](../adr/0182-europe-open-preset.md)). The credits of every visible source are shown together.

The intended use is hybrid: the application publishes an offline package of Europe on its own server, up to a level it
chooses, and the online sources add detail over land beyond it, tile by tile. The sea never loads online detail: it
comes from the package only, magnified beyond the package's sea level. Every `ts` example below type-checks against
the packages as a test (`scripts/integration/europe-preset-guide.test.ts`).

## Map types and sources

| Map type or overlay | Drawn from                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| Satellite           | ESA WorldCover 2021 Sentinel-2 composite (10 m, CC BY 4.0), from the package only; your own sources |
| Hybrid              | Satellite with OpenFreeMap's labels, borders and roads                                              |
| Map                 | OpenFreeMap's Liberty style (OpenMapTiles schema, OpenStreetMap data, ODbL)                         |
| Relief              | A hillshade of the terrain (Mapterhorn, Terrarium WebP tiles)                                       |
| Labels and borders  | OpenFreeMap: places, water names, peaks, borders, airports                                          |
| Roads               | OpenFreeMap: roads and their names                                                                  |
| 3D buildings        | OpenFreeMap: building footprints extruded to their height                                           |
| 3D terrain          | Copernicus GLO-30 in the package (Mapterhorn's extract), Mapterhorn online on land beyond it        |

Low levels use Natural Earth (public domain, the base image) wherever nothing else is drawn. `preset.sources` lists
every source in use with its terms, and `preset.excluded` the sources left out with the reason. Eleven national
and regional orthophotos with verified terms come with `@vibeglobe/presets/orthophotos` (below); IGN BD ORTHO, PNOA,
PDOK and others wait for their exact credit or endpoint ([open question 34](../open-questions.md)). An application whose
own review allows them adds them with `addSources`.

## Hybrid: the package plus online detail

The offline engine reads the package where it holds a tile and the network beyond it. The satellite composite is
package-only, the terrain reads the package first and Mapterhorn on land beyond it, and the vector style reads its
tiles through `transformUrl('hybrid')`: from the package up to its levels and over the sea, from OpenFreeMap beyond them
on land.

```ts
import { createGlobe } from '@vibeglobe/core';
import { addVectorTiles } from '@vibeglobe/layers/vector-tiles';
import { createOffline, createPackageManager } from '@vibeglobe/offline';
import { europeOpen, type StyleJson } from '@vibeglobe/presets';
import { createVectorTileTarget } from '@vibeglobe/renderer/vector-tiles';
import { pmtilesArchive } from '@vibeglobe/sources';
import { createWorkers } from '@vibeglobe/worker';

const offline = createOffline({ mode: 'hybrid' });
const packages = createPackageManager(offline, {
  // The package holds imagery and terrain archives: the adapter that accepts any content.
  adapters: {
    pmtiles: (o) => pmtilesArchive(o, 'any'),
    mbtiles: () => Promise.reject(new Error('no MBTiles')),
  },
});
const preset = europeOpen({
  packageManifestUrl: 'https://app.example/maps/europe-1.0.0/manifest.json',
  offline,
  onlineMaxLevel: { 'europe-terrain': 15 }, // ask Mapterhorn for no deeper level than 15
});
await packages.addServedPackage(preset.packageManifestUrl ?? '');

const hybrid = preset.baseMaps.find((b) => b.id === 'hybrid');
const globe = createGlobe({
  container,
  renderer,
  baseImageryUrl: '/assets/natural-earth.jpg',
  workers: createWorkers(),
  imagery: hybrid?.imagery ?? [],
  ...(preset.terrain ? { terrain: preset.terrain } : {}),
});
const style = (await (await fetch(preset.styleUrl('online'))).json()) as StyleJson;
const composed = preset.styleFor(style, 'hybrid', ['buildings']);
if (composed)
  await addVectorTiles(globe, {
    style: composed,
    target: createVectorTileTarget,
    element: container,
    transformUrl: preset.transformUrl('hybrid'),
  });
```

Switch the base map by replacing the imagery layers with the other base map's `imagery` and the vector layer with
`styleFor(style, baseId, overlayIds)`: Satellite and Hybrid share their imagery layer. The terrain is chosen when the
globe is created, so turning 3D terrain on or off creates the globe again (the playground reloads the page:
`?preset=europe`).

## Online only

Without `packageManifestUrl` the preset needs no offline engine and reads only the network: OpenFreeMap's vector
tiles everywhere and Mapterhorn's terrain over land. Satellite then shows only the application's own sources (no free
satellite imagery of Europe could be verified for online use), and Natural Earth elsewhere.

```ts
import { europeOpen } from '@vibeglobe/presets';

const preset = europeOpen({ onlineMaxLevel: { openfreemap: 14, 'europe-terrain': 13 }, exclude: ['openfreemap'] });
const satellite = preset.baseMaps.find((b) => b.id === 'satellite');
if (preset.packageManifestUrl !== undefined || satellite === undefined) throw new Error('online only');
// Every source with its licence, attribution and the day its terms were read.
const terms = preset.sources.map((s) => `${s.name}: ${s.license}, read ${s.termsReadDate}`);
```

## Offline only

`createOffline({ mode: 'offline' })` keeps every source off the network. The vector style, its TileJSON, fonts and
sprites come from the package folder's mirror of OpenFreeMap (`openfreemap/` next to the manifest, with the same paths
as on `tiles.openfreemap.org`): `transformUrl('offline')` maps every URL of the style there and every tile to the
package's vector and terrain folders. Beyond the package's levels, and over the sea beyond its sea level, the deepest
tile it holds is magnified.

```ts
import { createOffline } from '@vibeglobe/offline';
import { europeOpen } from '@vibeglobe/presets';

const offline = createOffline({ mode: 'offline' });
const preset = europeOpen({ packageManifestUrl: 'https://app.example/maps/europe-1.0.0/manifest.json', offline });
const styleUrl = preset.styleUrl('offline'); // https://app.example/maps/europe-1.0.0/openfreemap/styles/liberty
// Pass it as the `transformUrl` of `addVectorTiles`, with the style from `styleUrl`.
const transformUrl = preset.transformUrl('offline');
const fonts = transformUrl('https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/0-255.pbf');
if (!fonts.startsWith('https://app.example/maps/europe-1.0.0/openfreemap/fonts/') || !styleUrl.includes('openfreemap'))
  throw new Error('the style files are not read from the package');
```

## Your own sources

`addSources` adds the application's imagery sources to the satellite layer, above the preset's (or below with
`position: 'bottom'`), with their terms. Give each one an `area` so it is asked only within its borders; the source
below it is used elsewhere. A customer's Google Maps Platform key is read from the environment or the customer's
configuration, never committed:

```ts
import { createOffline } from '@vibeglobe/offline';
import { europeOpen } from '@vibeglobe/presets';
import { googleImagery, xyzImagery } from '@vibeglobe/sources';

const google = await googleImagery({
  id: 'google',
  apiKey: customerKey, // the customer's restricted key
  billingRegion: 'other', // satellite tiles are not offered to EEA billing accounts
  mapType: 'satellite',
  logoUrl: '/assets/google-logo.png',
});
// A national orthophoto, asked for only inside its polygon (here a box around South Tyrol).
const orthophoto = xyzImagery({
  id: 'my-orthophoto',
  url: 'https://ortho.example/{z}/{x}/{y}.jpg',
  maxLevel: 19,
  area: {
    polygons: [
      [
        [
          [10.38, 46.22],
          [12.48, 46.22],
          [12.48, 47.09],
          [10.38, 47.09],
        ],
      ],
    ],
  },
});
const record = (id: string, name: string, license: string, termsUrl: string) => ({
  id,
  name,
  kind: 'imagery' as const,
  tiers: 'network' as const,
  license,
  termsUrl,
  termsReadDate: '2026-10-26',
  attribution: [{ text: name }],
  minLevel: 0,
  maxLevel: 19,
  coverage: 'europe-land' as const,
});
const preset = europeOpen({
  packageManifestUrl: 'https://app.example/maps/europe-1.0.0/manifest.json',
  offline: createOffline({ mode: 'hybrid' }),
  addSources: [
    {
      source: orthophoto,
      record: record('my-orthophoto', 'My orthophoto', 'CC BY 4.0', 'https://ortho.example/terms'),
    },
    {
      source: google,
      record: record('google', 'Google', 'Google Maps Platform terms', 'https://cloud.google.com/maps-platform/terms'),
      position: 'bottom',
    },
  ],
});
```

Google's tiles are never packaged or cached persistently (the Google profile, [ADR 0031](../adr/0031-google-maps-platform-terms.md)).

## National and regional orthophotos

`@vibeglobe/presets/orthophotos` adds the open orthophoto services whose terms were verified (ADR 0182): basemap.at,
SWISSIMAGE, ČÚZK, DGT Portugal and seven German Länder. Each is a layer of its own, clipped per pixel to its country's or
Land's borders (Natural Earth, loaded on demand), above the satellite composite; outside them the composite shows.

```ts
import { europeOpen } from '@vibeglobe/presets';
import { europeOrthophotos } from '@vibeglobe/presets/orthophotos';

const orthophotos = await europeOrthophotos({ exclude: ['de-nw-dop'], onlineMaxLevel: { 'swisstopo-swissimage': 18 } });
const preset = europeOpen({ orthophotos });
const credits = preset.sources.filter((s) => s.kind === 'imagery').map((s) => s.attribution[0]?.text);
```

SWISSIMAGE is free under fair use (up to about 20,000 users a day); the other services publish no limit. The services
left out, with why, are `preset.excluded`.

## Maximum online zoom per area

The deepest level asked for online, by area and source, with the default options (`onlineMaxLevel` lowers them).
Beyond it the deepest tile is magnified.

| Area                                                                                                                                                          | Satellite                                                                              | Map, labels, roads, buildings                       | Terrain and relief                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| Land in Europe                                                                                                                                                | none online; the package up to 13 (WorldCover)                                         | 14 (OpenFreeMap; the package first up to its level) | 17 (Mapterhorn, where it holds them; the package first up to 12) |
| Sea in Europe                                                                                                                                                 | none online; the package up to 8                                                       | none in hybrid; the package up to 8, then magnified | none online; the package up to 8                                 |
| Outside Europe                                                                                                                                                | none (Natural Earth)                                                                   | 14 (OpenFreeMap)                                    | none                                                             |
| Austria, Switzerland, Czechia, mainland Portugal, Niedersachsen, NRW, Thüringen, Brandenburg, Berlin, Mecklenburg-Vorpommern, Sachsen-Anhalt, Rheinland-Pfalz | with `europeOrthophotos()`: 19 or 20, the service's own levels, clipped to its borders | as land in Europe                                   | as land in Europe                                                |

Mapterhorn's tiles are asked for down to level 17; where it holds no deeper tile, its deepest one is magnified. OpenFreeMap's vector tiles stop at level 14 and are
overzoomed beyond.

## Building the package

The pipeline configuration `packages/tools/configs/europe.json` builds the package from the same sources as the
preset, with the same ids (`europe-satellite`, `europe-terrain`, `europe-vectors`):

- `region` is Europe's bounding box (32° W to 45° E, 27° N to 72° N) and `land` the Natural Earth 1:50m land mask of
  Europe (`regions/europe-land.geojson`, made by `scripts/europe-land.ts`);
- each dataset's `minZoom` and `maxZoom` set the levels on land and `seaMaxZoom` the deepest level over the sea (8):
  above it only tiles touching land are counted and built;
- `bytesPerTile` and `seaBytesPerTile` are the sizes the estimate uses where nothing was measured.

The vector tiles and the terrain are copied from OpenFreeMap's and Mapterhorn's planet PMTiles archives with range
requests, tile by tile. OpenFreeMap's archive path carries its version: pin it before a build
(`--source-url europe-vectors=https://btrfs.openfreemap.com/areas/planet/<version>/tiles.pmtiles`); the build refuses
the unpinned `<version>` placeholder.

```sh
npm run build
node packages/tools/dist/bin.js estimate europe.json --measure
node packages/tools/dist/bin.js build europe.json --yes \
  --source-url europe-vectors=https://btrfs.openfreemap.com/areas/planet/20261020_001001_pt/tiles.pmtiles
```

Then write the package's manifest with `createManifest` of `@vibeglobe/offline` ([offline guide](offline.md)), one
entry per archive with its `sourceId` (`europe-satellite`, `europe-terrain`) and the licence and attribution from its
`metadata.json`.

## Estimating the package

`vibeglobe-data estimate <config>` counts the tiles of every level, land and sea apart, and prints the size and the
cumulative gigabytes per dataset without downloading anything. With `--measure` it first reads the real tile sizes on
the configuration's sample areas (`sampleArea` on land, `seaSampleArea` at sea): a sample build for the imagery, a few
tiles per level from the archives for vectors and terrain. Rows it could not measure say `configured`. The output for
`europe.json` (2026-10-26; the archive hosts were not reachable from the build machine, so vectors and terrain use the
configured sizes):

```text
Measuring tile sizes on the sample areas (only their tiles are read)…
  europe-terrain: not measured (fetch failed); sizes configured
  europe-vectors: not measured (fetch failed); sizes configured
Estimate (nothing has been downloaded):
  europe-satellite [region]
    zoom     land tiles     sea tiles         tiles          size    cumulative         sizes
    z5               37            19            56      787.5 kB       0.00 GB    configured
    z6              118            92           210        2.6 MB       0.00 GB    configured
    z7              374           438           812       12.4 MB       0.02 GB      measured
    z8            1,308         1,827         3,135       30.6 MB       0.05 GB      measured
    z9            4,662             0         4,662       93.2 MB       0.14 GB    configured
    z10          17,398             0        17,398      549.2 MB       0.69 GB      measured
    z11          66,781             0        66,781        1.9 GB       2.63 GB      measured
    z12         260,558             0       260,558        6.7 GB       9.34 GB      measured
    z13       1,028,226             0     1,028,226       22.3 GB      31.63 GB      measured
    total: 1,381,838 tiles, 63.3 GB written; download 8532 files, 2.4 TB
  europe-terrain [region]
    zoom     land tiles     sea tiles         tiles          size    cumulative         sizes
    z5               37            19            56        4.5 MB       0.00 GB    configured
    z6              118            92           210       14.3 MB       0.02 GB    configured
    z7              374           438           812       41.8 MB       0.06 GB    configured
    z8            1,308         1,827         3,135      146.6 MB       0.21 GB    configured
    z9            4,662             0         4,662      512.8 MB       0.72 GB    configured
    z10          17,398             0        17,398        1.7 GB       2.37 GB    configured
    z11          66,781             0        66,781        6.3 GB       8.72 GB    configured
    z12         260,558             0       260,558       20.8 GB      29.56 GB    configured
    total: 353,612 tiles, 59.1 GB written; download 0 files, 0 B
  europe-vectors [region]
    zoom     land tiles     sea tiles         tiles          size    cumulative         sizes
    z5               37            19            56        4.4 MB       0.00 GB    configured
    z6              118            92           210       14.2 MB       0.02 GB    configured
    z7              374           438           812       26.3 MB       0.04 GB    configured
    z8            1,308         1,827         3,135       92.1 MB       0.14 GB    configured
    z9            4,662             0         4,662      326.3 MB       0.46 GB    configured
    z10          17,398             0        17,398      608.9 MB       1.07 GB    configured
    z11          66,781             0        66,781        2.3 GB       3.41 GB    configured
    z12         260,558             0       260,558        5.2 GB       8.62 GB    configured
    z13       1,028,226             0     1,028,226       20.6 GB      29.19 GB    configured
    z14       4,083,365             0     4,083,365       49.0 GB      78.19 GB    configured
    total: 5,465,203 tiles, 156.4 GB written; download 0 files, 0 B
Totals: 7,200,653 tiles, output 278.8 GB, download 2.4 TB
Estimated cost: 0.00 USD (requester-pays transfer and requests; prices read 2026-10-21)
```

The cumulative column is the size of one copy (the static folder); `written` counts the static folder and the PMTiles
package together. The imagery's download is the Sentinel-2 source files it reads from, with range requests, so far
less than their full size is transferred. Lower a dataset's `maxZoom` to trade detail for size: each level is about
four times the one before it.

## Hosting the package

Publish the build's `output/` folder under a versioned path, for example `https://app.example/maps/europe-1.0.0/`,
following the [hosting guide](hosting.md) (range requests for PMTiles, CORS, caching, MIME types):

- `manifest.json` and the `europe-satellite.pmtiles` and `europe-terrain.pmtiles` archives, read by the offline engine;
- the static folders `europe-vectors/{z}/{x}/{y}.pbf` and `europe-terrain/{z}/{x}/{y}.webp`, read by the vector style
  and its hillshade through `transformUrl`;
- for offline-only use, `openfreemap/`: a copy of the Liberty style (`styles/liberty`), its TileJSON (`planet`), fonts
  and sprites from `tiles.openfreemap.org`, at the same paths.

Show the credits the globe gathers (`globe.credits()`, or its attribution element): every visible source's attribution, including OpenStreetMap's
and OpenMapTiles' for the vector tiles and Copernicus' notice for the terrain.
