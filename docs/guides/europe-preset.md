---
title: The Europe preset
---

# The Europe preset

`europeOpen(options)` of `@vibeglobe/presets` returns ready map types of Europe made only from free sources whose terms
allow commercial use and redistribution: five base maps, seven overlays, the 3D terrain, and every source's licence and
exact credit. It is built for hybrid use: an offline package of Europe that the application builds with
`@vibeglobe/tools` and serves itself, plus online detail over land beyond the package's levels. Other providers join
through `addSources` and the [sources guide](sources.md); packages of other areas are in the [offline guide](offline.md).

## Quick start

```ts
import { createGlobe } from '@vibeglobe/core';
import { addVectorTiles } from '@vibeglobe/layers/vector-tiles';
import { europeOpen, type StyleJson } from '@vibeglobe/presets';
import { createVectorTileTarget } from '@vibeglobe/renderer/vector-tiles';
import { createWorkers } from '@vibeglobe/worker';

const preset = europeOpen();
const hybrid = preset.baseMaps.find((b) => b.id === 'hybrid');
const globe = createGlobe({
  container,
  renderer,
  workers: createWorkers(),
  baseImageryUrl: '/imagery/natural-earth-4096.jpg',
  imagery: hybrid?.imagery ?? [],
  ...(hybrid?.polarCapColors ? { polarCapColors: hybrid.polarCapColors } : {}),
  ...(preset.terrain ? { terrain: preset.terrain } : {}),
});
const style = (await (await fetch(preset.styleUrl('online'))).json()) as StyleJson;
const composed = preset.styleFor(style, 'hybrid', ['buildings']);
if (composed) await addVectorTiles(globe, { style: composed, target: createVectorTileTarget, element: container });
```

Without a package the preset reads only the network: this globe shows Hybrid with 3D terrain and 3D buildings.
`globe.credits()` returns the credits of every visible source.

## Map types and sources

| Map type or overlay | `id`        | Drawn from                                                                             |
| ------------------- | ----------- | -------------------------------------------------------------------------------------- |
| Satellite           | `satellite` | Imagery that changes by zoom ([Satellite by zoom](#satellite-by-zoom))                 |
| Hybrid              | `hybrid`    | Satellite's imagery with OpenFreeMap's labels, borders and roads                       |
| Map                 | `map`       | A political map of OpenFreeMap's tiles: neutral land, blue water, borders, place names |
| Landscape           | `landscape` | OpenFreeMap's land cover in soft greens, light blue water, a light hillshade; no names |
| Relief              | `relief`    | Map over a tint by elevation and a hillshade of Mapterhorn's terrain                   |
| Labels and borders  | `labels`    | OpenFreeMap: places, water names, peaks, borders, airports                             |
| Roads               | `roads`     | OpenFreeMap: roads and railways by class, from level 6                                 |
| 3D buildings        | `buildings` | OpenFreeMap: building footprints extruded to their height                              |
| Borders             | `borders`   | Country borders at every level, region borders from level 5                            |
| Country names       | `countries` | Country names up to level 8                                                            |
| Sea names           | `seas`      | Ocean and sea names                                                                    |
| 3D terrain          | `terrain`   | Copernicus GLO-30 from the package, Mapterhorn online over Europe's land               |

- Roads show motorways from level 6, trunk and primary roads from 9, secondary and tertiary roads from 11, minor roads
  from 13 and the rest (service roads, tracks, paths, railways) from 14; road names show from 13.
- `borders`, `countries` and `seas` draw in light ink over imagery and in dark ink over the Landscape. Map and Relief
  ignore them and draw their own borders and names.
- `map`, `landscape` and the vector overlays need the `openfreemap` source; `relief` and `terrain` need
  `europe-terrain`. Excluding a source removes the map types that need it.
- Each `BaseMap` has its `imagery` layers, its `style` selection and its `polarCapColors`, the fill beyond 85.05°.
- `preset.sources` lists every source in use as a `PresetSourceRecord`: licence, `termsUrl`, `termsReadDate`,
  `attribution` and levels. `preset.excluded` lists the sources left out, each with its `reason`. Neither lists the
  globe's base image, which the application chooses.

## Hybrid: the package plus online detail

```ts
import { createGlobe } from '@vibeglobe/core';
import { addVectorTiles, type VectorTileLayer } from '@vibeglobe/layers/vector-tiles';
import { createOffline, createPackageManager } from '@vibeglobe/offline';
import { europeOpen, type BaseMap, type Overlay, type StyleJson } from '@vibeglobe/presets';
import { createVectorTileTarget } from '@vibeglobe/renderer/vector-tiles';
import { pmtilesArchive } from '@vibeglobe/sources';
import { createWorkers } from '@vibeglobe/worker';

const offline = createOffline({ mode: 'hybrid' });
// The package's archives hold imagery and terrain: the PMTiles adapter that accepts any content.
const packages = createPackageManager(offline, {
  adapters: { pmtiles: (o) => pmtilesArchive(o, 'any'), mbtiles: () => Promise.reject(new Error('no MBTiles')) },
});
const preset = europeOpen({ packageManifestUrl: 'https://app.example/maps/europe-1.0.0/manifest.json', offline });
await packages.addServedPackage(preset.packageManifestUrl ?? '');

const globe = createGlobe({
  container,
  renderer,
  workers: createWorkers(),
  baseImageryUrl: '/imagery/natural-earth-4096.jpg',
  imagery: preset.baseMaps.find((b) => b.id === 'satellite')?.imagery ?? [],
  ...(preset.terrain ? { terrain: preset.terrain } : {}),
});
await globe.ready;
const style = (await (await fetch(preset.styleUrl('online'))).json()) as StyleJson;
let vectors: VectorTileLayer | undefined;

async function show(baseId: BaseMap['id'], overlayIds: Overlay['id'][]): Promise<void> {
  const base = preset.baseMaps.find((b) => b.id === baseId);
  if (!base) return;
  if (base.polarCapColors) globe.setPolarCapColors(base.polarCapColors);
  for (const layer of globe.imageryLayers.list())
    if (!base.imagery.some((l) => l.id === layer.id)) globe.imageryLayers.remove(layer.id);
  for (const layer of base.imagery)
    if (!globe.imageryLayers.list().some((l) => l.id === layer.id)) globe.imageryLayers.add(layer);
  vectors?.remove();
  const composed = preset.styleFor(style, baseId, overlayIds);
  vectors = composed
    ? await addVectorTiles(globe, {
        style: composed,
        target: createVectorTileTarget,
        element: container,
        transformUrl: preset.transformUrl('hybrid'),
      })
    : undefined;
}
await show('hybrid', ['buildings']);
```

- The satellite imagery comes from the package only. The 3D terrain comes from the package first, then from
  Mapterhorn over land.
- Inside `EUROPE_BOUNDS`, `transformUrl('hybrid')` reads vector and hillshade tiles from the package over the sea at
  every level and on land up to the package's levels (`packageLevels`, 11). Beyond them on land, and outside the
  bounds, it reads the network. A tile the package does not hold is drawn from its nearest ancestor.
- `show` switches the base map: the imagery layers by id (Satellite and Hybrid share theirs), the polar caps and the
  vector layer.
- The terrain is chosen when the globe is created: turning `terrain` on or off creates the globe again.

## Online only

Without `packageManifestUrl` the preset needs no offline engine ([Quick start](#quick-start)). Satellite then shows
NASA's Blue Marble (500 m) up to level 8, magnified beyond, under the `orthophotos` and the added sources. The free
detailed satellite services checked do not allow commercial use online: `preset.excluded` lists them with why.

## Offline only

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

`createOffline({ mode: 'offline' })` keeps every source off the network. `transformUrl('offline')` maps the style's
files (style, TileJSON, fonts, sprites) to `openfreemap/` under `packageBaseUrl`, and every tile to the package's
`europe-vectors/` and `europe-terrain/` folders. Beyond the package's levels the deepest tile is magnified.

## Satellite by zoom

With a package and the default `farLevels` (4), Satellite and Hybrid change by zoom without hard edges: each layer fades
in over the whole view at once. A level shows at about the zoom one below it.

| Levels (zoom) | Europe's land                                                                |
| ------------- | ---------------------------------------------------------------------------- |
| 0–4 (below 4) | The globe's base image (`baseImageryUrl`)                                    |
| 5–6 (4–5)     | The package's WorldCover fading in, in the base image's tones                |
| 6–9 (5–8)     | WorldCover, its tones fading from the base image's to its own                |
| 9–11 (8–10)   | WorldCover in its own colors (10 m data)                                     |
| 12–13 (11–12) | The online sources fading in over WorldCover, in their own colors            |
| beyond 13     | Each online source to its own deepest level; without one, level 11 magnified |

- `farLevels` moves the first steps: WorldCover starts at level `farLevels + 1` and shows its own tones from level
  `farLevels + 5`. The online layers always fade in over levels 12 to 13.
- The sea, the polar caps and everything outside the package's box (32° W to 45° E, 27° N to 72° N) show the base
  image at every level, unless the [world package](#the-world-package) covers the world's land: WorldCover's water is keyed out outside `EUROPE_LAND`, fading back in over 4 km inside it.
  With the [package's sea](#the-sea) the keyed water shows NASA's Blue Marble with its depth instead of the base image.
- From level 9 the package holds Europe's land only; elsewhere in the box its level 8 tiles are magnified.
- Online only, NASA's Blue Marble replaces WorldCover, land and sea, in its own colors, fading in from level
  `farLevels + 0.5` to `farLevels + 1`.
- Without online sources, level 11 (about 54 m a pixel at 45° N) is the finest on land: level 14 magnifies it 8 times.
- Satellite's and Hybrid's `polarCapColors` are Natural Earth's (`#7aacd0`, `#eef1f6`). With another base image, pass
  the mean color of its rows beyond 85.05° to `globe.setPolarCapColors`.

## Your own sources

```ts
import { createOffline } from '@vibeglobe/offline';
import { europeOpen } from '@vibeglobe/presets';
import { fetchTransport, withProfile, xyzImagery } from '@vibeglobe/sources';

// The customer's provider: its key added only when a tile is requested, its terms in its profile.
const provider = withProfile(
  xyzImagery({
    id: 'provider',
    url: 'https://tiles.provider.example/{z}/{x}/{y}.jpg',
    minLevel: 12,
    transport: fetchTransport(undefined, undefined, { secretQuery: () => ({ key: customerKey }) }),
  }),
  {
    id: 'provider',
    forbids: new Set(['persistentCache', 'offlinePackaging']),
    respectCacheHeaders: true,
    requiredAttribution: { text: 'Provider' },
  },
);
// A regional orthophoto, asked for only inside its polygon (here a box around South Tyrol).
const orthophoto = xyzImagery({
  id: 'my-orthophoto',
  url: 'https://ortho.example/{z}/{x}/{y}.jpg',
  minLevel: 12,
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
  minLevel: 12,
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
      source: provider,
      record: record('provider', 'Provider', "The provider's terms", 'https://provider.example/terms'),
      position: 'bottom',
    },
  ],
});
```

- `addSources` adds the application's imagery sources to Satellite and Hybrid, with their terms in `preset.sources`.
  `position: 'top'` (the default) asks a source before the preset's; `'bottom'` only where nothing above has data.
- A source with `minLevel` above 11 goes into its own layer, `satellite-online`, fading in over levels 12 to 13 in its
  own colors. A source with a lower `minLevel` joins the `satellite` layer, its tones matched like WorldCover's.
- Give each source an `area`, so it is asked only where it has data.
- A paid provider's key stays out of the code: `secretQuery` adds it to tile requests only, and the profile's `forbids`
  keeps its tiles out of packages and the persistent cache. The [sources guide](sources.md) connects Google's Map Tiles
  API this way.

## National and regional orthophotos

```ts
import { europeOpen } from '@vibeglobe/presets';
import { europeOrthophotos } from '@vibeglobe/presets/orthophotos';

const orthophotos = await europeOrthophotos({
  exclude: ['de-nw-dop'],
  onlineMaxLevel: { 'swisstopo-swissimage': 18 },
  keys: { 'fi-mml': customerKey },
});
const preset = europeOpen({ orthophotos });
const credits = preset.sources.filter((s) => s.kind === 'imagery').map((s) => s.attribution[0]?.text);
```

`@vibeglobe/presets/orthophotos` holds the open orthophoto services whose terms allow commercial use and
redistribution: France (IGN), Spain (PNOA), mainland Portugal (DGT), the Netherlands (PDOK), Belgium (Flanders,
Wallonia, Brussels), Luxembourg, Switzerland (SWISSIMAGE), Austria (basemap.at), Czechia (ČÚZK), Slovakia, Slovenia,
Poland, Croatia, Estonia, Finland and Denmark (with a key), fourteen German Länder (all but Saarland and
Schleswig-Holstein), Alto Adige and the city of Bologna. `EUROPE_ORTHOPHOTOS` holds their records, with ids and levels.

- Each service is a layer of its own, clipped per pixel to its country's or region's borders, above the satellite
  imagery and below the vector overlays. Borders load on demand.
- Each starts at level 12 (`ORTHOPHOTO_MIN_LEVEL`), fades in over levels 12 to 13 and goes to its own deepest level,
  18 to 21. A white tile counts as no data, so the imagery below shows through it.
- They are online services: never packaged, asked in `online` and `hybrid` mode, never in `offline` mode.
- Finland (`fi-mml`) and Denmark (`dk-geodanmark`) need the application's own key, free on registration with the
  National Land Survey of Finland and with Datafordeler: without it in `keys` the service is left out.
- SWISSIMAGE allows about 20,000 users a day under fair use; the Polish Geoportal bars bulk downloading; Finland's open
  interface is not meant for high-volume services. Each record's `limits` holds its provider's stated limits.
- Some credits carry a year (`© IGN 2026 – BD ORTHO®`): update it with your own reading of the terms.
- No service is included for the rest of Italy, the United Kingdom, Ireland, Norway, Sweden, Hungary, Romania, Bulgaria,
  the Balkans, Greece or a Europe-wide mosaic: there the package's WorldCover is the detail.
- `withAllOnlineSources(options, orthophotoOptions)` returns `options` with `orthophotos` loaded, `onlineMaxLevel`
  passed on: `europeOpen(await withAllOnlineSources({ … }))`.

## The Landscape

```ts
import { europeOpen, type StyleJson } from '@vibeglobe/presets';
import { singleImage } from '@vibeglobe/sources';

const image = '/imagery/land-cover-4096.webp';
const source = await singleImage({ id: 'land-cover', image, bounds: [-180, -90, 180, 90], sizePx: [4096, 2048] });
const preset = europeOpen({
  landCover: {
    source,
    record: {
      id: 'land-cover',
      name: 'MODIS land cover (NASA)',
      kind: 'imagery',
      tiers: 'network',
      license: 'Public domain',
      termsUrl: 'https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api',
      termsReadDate: '2026-10-30',
      attribution: [{ text: 'NASA MODIS land cover' }],
      minLevel: 0,
      maxLevel: 6,
      coverage: 'world',
    },
  },
});
const style = (await (await fetch(preset.styleUrl('online'))).json()) as StyleJson;
const composed = preset.styleFor(style, 'landscape', ['borders', 'countries', 'seas'], 'it');
```

The Landscape draws the tiles' land cover from level 7, urban areas from level 9, and a light hillshade up to zoom 11
when the terrain is included. Below level 7 the tiles hold no land cover: the land is one color unless `landCover`
gives an image of the world's land cover in `LANDSCAPE_COLORS`, which the tiles' land color covers from level 7 to 8.
With `sizePx` the image downloads only once the Landscape shows. One public-domain way to make it: NASA's MODIS land
cover from GIBS's WMS (`https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi`) with these parameters, a PNG with
one exact color per class:

```text
LAYERS=MODIS_Combined_L3_IGBP_Land_Cover_Type_Annual&CRS=EPSG:4326&BBOX=-90,-180,90,180&WIDTH=8192&HEIGHT=4096
```

Map forests to `forest`; grassland, savanna, wetland and closed shrubland to `grass`; croplands to `field`; open
shrubland to `land`; barren to `bare`; urban to `urban`; snow to `ice`; water to `water`. Resize to 4096 × 2048, blur
by one pixel and save as WebP (about 240 KB).

`styleFor`'s last argument names places in that language where the tiles have it (`name:it`), else in their Latin or
local name. Names take the style's own faces: country names its bold font, places its regular one, water its italic.

### Overlay and Landscape layers

Ask for one style with every overlay a page offers and switch them with the vector layer's runtime style
(`setVisibility`, see [vector tiles](vector-tiles.md#runtime-changes)): a new style downloads and lays out every tile
again. These layer ids are stable:

| Part        | Layers                                                                                                |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| `borders`   | `overlay-region-borders` (from level 5), `overlay-country-borders`                                    |
| `countries` | `overlay-country-names` (to level 8)                                                                  |
| `seas`      | `overlay-sea-names`                                                                                   |
| `roads`     | the style's own layers of the `transportation` and `transportation_name` source layers                |
| `landscape` | `landscape-land`, `landscape-<class>` (`wood`, `grass`, `wetland`, `farmland`, `rock`, `sand`, `ice`) |
| `landscape` | `landscape-urban`, `landscape-hillshade`, `landscape-water`, `landscape-rivers`                       |

Country features carry `iso_a2`: a page that labels some countries itself hides the map's names for them with
`vectors.setLabelsHidden('overlay-country-names', { property: 'iso_a2', values: ['IT', 'ES'] })`.

## Maximum online zoom per area

The deepest level asked for, by area and source, with the default options. Beyond it the deepest tile is magnified:
the preset sets no zoom limit.

| Area                      | Satellite (with a package)                               | Map, labels, roads, buildings                      | Terrain and relief                                |
| ------------------------- | -------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------- |
| Europe's land             | The package to 11; added online sources to their own     | 14 (OpenFreeMap); hybrid: the package first, to 11 | 17 (Mapterhorn); hybrid: the package first, to 11 |
| Europe's sea              | The base image                                           | Hybrid: the package to 8; online: 14               | none                                              |
| Outside the package's box | The base image; with `worldLand`, the world package to 8 | 14 (OpenFreeMap)                                   | none                                              |
| An orthophoto's area      | With `orthophotos`: from 12 to the service's 18–21       | as Europe's land                                   | as Europe's land                                  |

Online only, Satellite is NASA's Blue Marble to level 8 everywhere, under the online sources.

## Building the package

The pipeline configuration `europe.json` of `@vibeglobe/tools` builds the package from the same sources as the
preset, with the same ids (`europe-satellite`, `europe-terrain`, `europe-vectors`):

- `region` is the package's box (32° W to 45° E, 27° N to 72° N) and `land` Natural Earth's 1:50m land of Europe
  (`regions/europe-land.geojson`).
- Each dataset's `minZoom` and `maxZoom` set its levels on land (5 to 11) and `seaMaxZoom` its deepest level over the
  sea (8); above it only tiles touching land are built.
- `bytesPerTile` and `seaBytesPerTile` are the tile sizes the estimate uses where nothing is measured.
- The imagery is the ESA WorldCover 2021 composite, read from its bucket with range requests. The vector tiles and the
  terrain are copied tile by tile from OpenFreeMap's and Mapterhorn's planet PMTiles archives.
- OpenFreeMap's archive path carries its version: pin it with `--source-url`; the build refuses the `<version>`
  placeholder.

```sh
npx vibeglobe-data estimate europe.json --measure
npx vibeglobe-data build europe.json --yes --out ./europe-package \
  --source-url europe-vectors=https://btrfs.openfreemap.com/areas/planet/20261020_001001_pt/tiles.pmtiles
```

Then write the package's `manifest.json` with `createManifest` of `@vibeglobe/offline` ([offline guide](offline.md)):
one `sources` entry per archive, with its `sourceId` (`europe-satellite`, `europe-terrain`), `file`, levels, and the
`license` and `attribution` from the dataset's `metadata.json`. A package built to other levels tells the preset with
`packageLevels`: `europeOpen({ packageLevels: { imagery: 13 } })` reads the satellite imagery to level 13.

### The world package

`world-satellite.json` builds the same WorldCover composite over the world's land (Natural Earth 1:50m without
Antarctica, `regions/world-land.geojson`) at levels 3 to 8, the sea to level 6: 26,091 tiles, about 0.46 GB for one
copy by the configured tile sizes. It reads only overview level 4 (about 160 m) of the composite. Add its `world-satellite.pmtiles` to the package
with `sourceId` `world-satellite`, then pass the world's land:

```text
europeOpen({ packageManifestUrl, offline, farLevels: 2, worldLand: WORLD_LAND })
```

`WORLD_LAND` comes from `@vibeglobe/presets/world-land`, a module of its own so the land loads only with it. The world's
imagery then shows from level `farLevels + 1` to `packageLevels.world` (8), its sea keyed out on that land; Europe's
imagery starts at level 9, so the package's Europe levels 5 to 8 go unread. Antarctica stays the base image. Beyond
level 8 outside Europe, an added online source takes over, or level 8 is magnified.

### The sea

`world-sea.json` copies NASA's Blue Marble with shaded relief and bathymetry (500 m, no restrictions on use) from GIBS's
Web Mercator tiles over the whole world at levels 0 to 7: 21,845 tiles, about 0.17 GB as JPEG. Add its
`world-sea.pmtiles` to the package with `sourceId` `world-sea` and pass its deepest level:

```text
europeOpen({ packageManifestUrl, offline, farLevels: 2, worldLand: WORLD_LAND, packageLevels: { sea: 7 } })
```

It becomes Satellite's and Hybrid's lowest layer, `satellite-base`, fading in over the base image from level
`farLevels + 0.5` and magnified beyond level 7: every water pixel keyed out of the imagery above, the packages' and an
online source's keyed with `keySea`, shows the sea's depth, deep blue offshore and lighter over the shelves.

## Estimating the package

`vibeglobe-data estimate <config>` counts the tiles of every level, land and sea apart, and prints the size and the
cumulative gigabytes per dataset without downloading anything. `--measure` first reads real tile sizes on the
configuration's sample areas (`sampleArea` on land, `seaSampleArea` at sea): a sample build for the imagery, a few
tiles per level from the archives for vectors and terrain. Rows it could not measure say `configured`. The output for
`europe.json` without `--measure`, whose satellite sizes are the averages measured below:

```text
Estimate (nothing has been downloaded):
  europe-satellite [region]
    zoom     land tiles     sea tiles         tiles          size    cumulative         sizes
    z5               37            19            56      787.5 kB       0.00 GB    configured
    z6              118            92           210        2.6 MB       0.00 GB    configured
    z7              374           438           812        8.6 MB       0.01 GB    configured
    z8            1,308         1,827         3,135       37.8 MB       0.05 GB    configured
    z9            4,662             0         4,662      118.4 MB       0.17 GB    configured
    z10          17,398             0        17,398      441.9 MB       0.61 GB    configured
    z11          66,781             0        66,781        1.6 GB       2.23 GB    configured
    total: 93,054 tiles, 4.5 GB written; download 8532 files, 2.4 TB
  europe-terrain [region]
    zoom     land tiles     sea tiles         tiles          size    cumulative         sizes
    z5               37            19            56        4.5 MB       0.00 GB    configured
    z6              118            92           210       14.3 MB       0.02 GB    configured
    z7              374           438           812       41.8 MB       0.06 GB    configured
    z8            1,308         1,827         3,135      146.6 MB       0.21 GB    configured
    z9            4,662             0         4,662      512.8 MB       0.72 GB    configured
    z10          17,398             0        17,398        1.7 GB       2.37 GB    configured
    z11          66,781             0        66,781        6.3 GB       8.72 GB    configured
    total: 93,054 tiles, 17.4 GB written; download 0 files, 0 B
  europe-vectors [region]
    zoom     land tiles     sea tiles         tiles          size    cumulative         sizes
    z5               37            19            56        4.4 MB       0.00 GB    configured
    z6              118            92           210       14.2 MB       0.02 GB    configured
    z7              374           438           812       26.3 MB       0.04 GB    configured
    z8            1,308         1,827         3,135       92.1 MB       0.14 GB    configured
    z9            4,662             0         4,662      326.3 MB       0.46 GB    configured
    z10          17,398             0        17,398      608.9 MB       1.07 GB    configured
    z11          66,781             0        66,781        2.3 GB       3.41 GB    configured
    total: 93,054 tiles, 6.8 GB written; download 0 files, 0 B
Totals: 279,162 tiles, output 28.7 GB, download 2.4 TB
Estimated cost: 0.00 USD (requester-pays transfer and requests; prices read 2026-10-21)
```

The cumulative column is the size of one copy (the static folder); `written` counts the static folder and the PMTiles
archive together. The imagery's download counts the WorldCover files it reads from; range requests transfer far less.
Each level is about four times the one before it: lower a dataset's `maxZoom` to trade detail for size.

### The WorldCover package by its deepest level

The satellite package's size on land (the sea stops at 8), from real WorldCover tiles of six land areas (the Alps
around Mont Blanc, the Beauce, Paris, the Po valley, the Spanish Meseta, a Swedish forest; about 30 tiles per area and
level), built by the pipeline and averaged. One copy, in decimal gigabytes.

| Deepest level | Land tiles at that level | Average tile | That level | Package (levels 5 to it) |
| ------------- | ------------------------ | ------------ | ---------- | ------------------------ |
| 10            | 17,398                   | 25.4 kB      | 0.44 GB    | 0.58 GB                  |
| 11 (default)  | 66,781                   | 24.3 kB      | 1.62 GB    | 2.20 GB                  |
| 12            | 260,558                  | 22.0 kB      | 5.72 GB    | 7.93 GB                  |
| 13            | 1,028,226                | 18.6 kB      | 19.09 GB   | 27.0 GB                  |

Level 13 holds WorldCover's 10 m detail in full: where no orthophoto covers the land, zoom 15 shows it magnified four
times instead of level 11 sixteen times. The orthophotos still fade in from level 12 above it.

## Hosting the package

Publish the build's `output/` folder and the manifest under a versioned path, such as
`https://app.example/maps/europe-1.0.0/`, following the [hosting guide](hosting.md) (range requests, CORS, caching,
MIME types):

- `manifest.json` and the archives `europe-satellite.pmtiles`, `europe-terrain.pmtiles` (and
  `world-satellite.pmtiles`, `world-sea.pmtiles`), read by the offline engine;
- the static folders `europe-vectors/{z}/{x}/{y}.pbf` and `europe-terrain/{z}/{x}/{y}.webp`, read by the vector style
  and its hillshade through `transformUrl`;
- for offline use, `openfreemap/`: a copy of the Liberty style (`styles/liberty`), its TileJSON (`planet`), fonts and
  sprites from `tiles.openfreemap.org`, at the same paths.

## Options

`EuropeOpenOptions`; the TSDoc has the details.

| Option               | Type                                        | Default               | Effect                                                                           |
| -------------------- | ------------------------------------------- | --------------------- | -------------------------------------------------------------------------------- |
| `packageManifestUrl` | `string`                                    | none: online only     | The package's manifest; needs `offline`                                          |
| `offline`            | `OfflineWrapper`                            | none                  | The offline engine (`createOffline()`); required with a package                  |
| `packageBaseUrl`     | `string`                                    | the manifest's folder | Where the package's static folders and `openfreemap/` mirror are                 |
| `packageLevels`      | `{ vectors, terrain, imagery, world, sea }` | 11, 11, 11, 8, none   | The package's deepest levels: each dataset's `maxZoom`; `sea` adds the sea layer |
| `worldLand`          | `readonly PolygonDeg[]`                     | none                  | `WORLD_LAND`, with the world package                                             |
| `farLevels`          | `number`                                    | 4                     | Levels 0 to this show the base image in Satellite and Hybrid                     |
| `onlineMaxLevel`     | `Record<string, number>`                    | each source's deepest | Lowers `openfreemap` (14) and `europe-terrain` (17)                              |
| `exclude`            | `readonly string[]`                         | none                  | Source ids to leave out                                                          |
| `addSources`         | `readonly AddedSource[]`                    | none                  | The application's imagery sources in Satellite and Hybrid                        |
| `orthophotos`        | `OrthophotoLayers`                          | none                  | `await europeOrthophotos()`                                                      |
| `landCover`          | `AddedSource`                               | none                  | The Landscape's land cover image below level 7                                   |

## Rules and pitfalls

- `imageryLayers.add` works only on a globe created with imagery and `workers`, after `globe.ready`: a globe that
  starts on Map or Relief is created with Satellite's imagery layers set to `visible: false`.
- The base image (`baseImageryUrl`) is the far view and, with a package, the sea at every level: host it with the
  application, so both look the same online and offline.
- `onlineMaxLevel` of `europeOpen` applies to `openfreemap` and `europe-terrain` only. Orthophotos take theirs in
  `europeOrthophotos`; an added source keeps its own `maxLevel`.
- `packageLevels` must equal each dataset's `maxZoom` in the build.
- Where Mapterhorn holds no deeper terrain (parts of Italy end at level 13), the first missing level answers 404 once
  per tile and nothing deeper is asked; `onlineMaxLevel: { 'europe-terrain': 13 }` avoids the 404s.
- The Landscape's hillshade stops at zoom 11: nearer, the 3D terrain shows the relief, and a tilted view would shade
  hundreds of terrain tiles on the CPU.
- OpenFreeMap's vector tiles stop at level 14 and are overzoomed beyond.
- The application shows the credits: `globe.credits()` or the attribution element gathers every visible source's,
  including OpenStreetMap's and OpenMapTiles' for the vector tiles and Copernicus' notice for the packaged terrain.

## Errors

| Error or code                                                                 | When                                                       | What to do                                       |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------ |
| `europeOpen: a packageManifestUrl needs the offline engine (options.offline)` | `packageManifestUrl` without `offline`                     | Pass `offline: createOffline({ mode })`          |
| `GlobeError` `invalid-option` from `imageryLayers.add`                        | Before `globe.ready`, or a globe created without `workers` | Await `ready`; create the globe with `workers`   |
| `europe-vectors: pin the archive's version before a build: …`                 | `vibeglobe-data build` with the `<version>` placeholder    | Pass `--source-url europe-vectors=<archive URL>` |
| `Not confirmed: non-interactive runs must pass --yes …`                       | A build without a terminal                                 | Review the estimate, then pass `--yes`           |

## See also

- [Sources](sources.md): adapters, provider profiles and keys for `addSources`.
- [Offline](offline.md): network modes, the package manager and `createManifest`.
- [Hosting](hosting.md): serving the package.
- [Vector tiles](vector-tiles.md): styles and runtime changes.
- [Data licenses](../data-licenses.md): the pipeline's datasets and their credits.
