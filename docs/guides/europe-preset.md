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

| Map type or overlay | Drawn from                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Satellite           | By zoom: the globe's base image (Natural Earth) far away and over the sea, the ESA WorldCover 2021 Sentinel-2 composite (10 m, CC BY 4.0) from the package fading in over the package's box (NASA's Blue Marble from GIBS instead without a package), then your online sources and the orthophotos above the package's level 11 (below)                  |
| Hybrid              | Satellite with OpenFreeMap's labels, borders and roads                                                                                                                                                                                                                                                                                                   |
| Map                 | A political map from OpenFreeMap's tiles: neutral land, blue water, country and region borders, place names; no land cover, land use or buildings                                                                                                                                                                                                        |
| Landscape           | A map like a virtual globe's from OpenFreeMap's tiles: land in soft greens and whites by its cover (forests, open land, fields, rock, sand, ice), light blue water and a light hillshade; no borders, names or roads, which are overlays (F644). Below level 7 the tiles hold no land cover: the app's land cover image shows there (`landCover`, below) |
| Relief              | Map over a light tint by elevation and a hillshade of the terrain (Mapterhorn, Terrarium WebP tiles)                                                                                                                                                                                                                                                     |
| Labels and borders  | OpenFreeMap: places, water names, peaks, borders, airports                                                                                                                                                                                                                                                                                               |
| Roads               | OpenFreeMap: roads and their names, off by default, on Map as on Satellite; each class from its level: motorways from 6, trunk and primary roads from 9, secondary and tertiary from 11, minor roads from 13, the rest (service roads, tracks, paths, railways) from 14, and road names from 13                                                          |
| Borders             | OpenFreeMap: country borders at every level and region borders from level 5, none finer; dark on Landscape, light on imagery (F645)                                                                                                                                                                                                                      |
| Country names       | OpenFreeMap: country names to level 8 (F645)                                                                                                                                                                                                                                                                                                             |
| Sea names           | OpenFreeMap: ocean and sea names (F645)                                                                                                                                                                                                                                                                                                                  |
| 3D buildings        | OpenFreeMap: building footprints extruded to their height                                                                                                                                                                                                                                                                                                |
| 3D terrain          | Copernicus GLO-30 in the package (Mapterhorn's extract), Mapterhorn online on land beyond it                                                                                                                                                                                                                                                             |

The polar caps beyond Web Mercator's 85.05° look like the surface around them: Natural Earth's colors fill them in Satellite
and Hybrid, and Map and Relief give `polarCapColors` (their water in the north, their land in the south), which the
application passes to `globe.setPolarCapColors` when it switches base map. The imagery layers can be switched only on a
globe created with imagery, so a globe that starts on Map or Relief is created with the satellite layers hidden.

Low levels use Natural Earth (public domain, the base image) wherever nothing else is drawn. `preset.sources` lists
every source in use with its terms, and `preset.excluded` the sources left out with the reason. Eleven national
and regional orthophotos with verified terms come with `@vibeglobe/presets/orthophotos` (below); IGN BD ORTHO, PNOA,
PDOK and others wait for their exact credit or endpoint ([open question 34](../open-questions.md)). An application whose
own review allows them adds them with `addSources`.

## Landscape and its labels

The Landscape (F644) draws the tiles' land cover from level 7. Farther away the land is one color unless the app passes
an image of the world's land cover in the Landscape's colors as `landCover`: the land color covers it from level 7 to 8.
One way to make it, public domain: NASA's MODIS land cover (MCD12Q1, IGBP classes) from GIBS's WMS,
`LAYERS=MODIS_Combined_L3_IGBP_Land_Cover_Type_Annual&CRS=EPSG:4326&BBOX=-90,-180,90,180&WIDTH=8192&HEIGHT=4096`, whose
PNG holds one exact color per class; map each class to `LANDSCAPE_COLORS` (forests to `forest`, grassland, savanna,
wetland and shrubland to `grass`, croplands to `field`, open shrubland to `land`, barren to `bare`, urban to `urban`,
snow to `ice`, water to `water`), resize to 4096 × 2048, blur by a pixel and save as WebP (about 240 KB).

Pass it as `landCover: { source: await singleImage({ id, image, bounds: [-180, -90, 180, 90], sizePx: [4096, 2048] }), record }`
(`singleImage` of `@vibeglobe/sources`, `record` its terms; with its size the image downloads only once the Landscape
shows), then ask for a style such as
`preset.styleFor(json, 'landscape', ['borders', 'countries'], 'it')`.

The borders, country names and sea names overlays (F645) draw over Satellite and Landscape alike, in dark ink on the
map and light on the imagery (names and sea names white, country borders a light grey at 75 % that recedes into the
picture, region borders a fainter grey); Map and Relief keep their own names and borders. `styleFor`'s last argument names places in a language where the tiles have it
(`name:it`), else in their Latin or local name. Names take the style's own faces (KB-243): country names its bold font,
places its regular one, water its italic one.

The Landscape's hillshade is light and stops at zoom 11 (KB-242): nearer, the 3D terrain shows the relief, and a tilted
view would shade hundreds of DEM tiles on the CPU.

### Switching overlays without reloading tiles

Ask for one style with every overlay a page offers and switch them with the layer's runtime style (see
[vector tiles](vector-tiles.md#runtime-changes)), not by asking for a new style: a new layer downloads and lays out
every tile again. The overlays' layers:

| Overlay     | Layers                                                             |
| ----------- | ------------------------------------------------------------------ |
| `borders`   | `overlay-region-borders` (from level 5), `overlay-country-borders` |
| `countries` | `overlay-country-names` (to level 8)                               |
| `seas`      | `overlay-sea-names`                                                |
| `roads`     | the style's own `transportation` and `transportation_name` layers  |

Country features carry `iso_a2`. A page that names some countries with labels of its own (a plaque with its figures,
say) hides the map's name for those, at every zoom, with a filter on `overlay-country-names`:
`['all', original, ['!', ['in', ['get', 'iso_a2'], ['literal', ['IT', 'ES']]]]]`. Its own label then reads as the
map's if it copies the paint: Noto Sans Bold, 10 px at zoom 1 rising by 1.2 px a level to 16 px, white with a
`rgba(0, 0, 0, 0.6)` halo of 1.4 px over imagery, `#2f2c33` with a white halo over the Landscape.

## Another base image

The far levels show the application's base image (`baseImageryUrl`). The guides use Natural Earth; NASA's Blue Marble
(public domain) gives a virtual globe's colors. GIBS's WMS gives it at 4096 × 2048
(`LAYERS=BlueMarble_ShadedRelief_Bathymetry&CRS=EPSG:4326&BBOX=-90,-180,90,180&WIDTH=4096&HEIGHT=2048`), the layer the
online Satellite uses nearer, so the tones meet. Its bright shelves look blocky magnified, and with a package the sea
is the base image at every level: a calmer sea comes from a blur of the sea alone (a mask from
`BlueMarble_NextGeneration`, whose ocean is one flat dark blue; the sea's colors and the mask blurred alike and divided,
so the land never bleeds into the coast), brought partway to a deep blue. Satellite's `polarCapColors` are Natural
Earth's: with another image pass the mean of its rows beyond 85.05° to `globe.setPolarCapColors` (about `#091738` and
`#eeefef` for the Blue Marble).

## Satellite by zoom

Satellite and Hybrid change by zoom with no block, hard edge or jump of color or sharpness (F636, F638, F639). Each
layer fades in over the whole view at once (`fadeIn`, F635), and in time too: its opacity changes no faster than from 0 to
1 in 600 ms (F670), so a fast zoom crosses a fade as a cross-fade instead of switching it like a light. The package's tones match the base image's at the far
levels only, and the match fades out by level 9 (`harmonize: 'below'` with `harmonizeFade`, F633, F638):

| Levels (zoom at the center) | Europe's land                                                      | Sea and polar regions     |
| --------------------------- | ------------------------------------------------------------------ | ------------------------- |
| 0–5 (zoom below 4)          | The globe's base image (`baseImageryUrl`)                          | The base image            |
| 5–6 (zoom 4–5)              | The package's WorldCover fading in, in the base image's tones      | The base image            |
| 6–9 (zoom 5–8)              | WorldCover, its tones fading from the base image's to its own      | The base image            |
| 9–11                        | WorldCover in its own colors (to its level 11, 10 m data)          | The base image, magnified |
| 12–13 (zoom 11–12)          | Your online sources fading in over WorldCover, in their own colors | The base image, magnified |
| 13 and beyond               | Each online source to its own deepest level                        | The base image, magnified |

- **Far away** the globe shows its own base image, the one the application passes as `baseImageryUrl`: the guides use
  Natural Earth I with shaded relief and water (`apps/playground/public/imagery/natural-earth-4096.jpg`, public
  domain). It is local, so the far view is the same offline, in hybrid and online. `farLevels` (default 4) moves the
  first switch: `farLevels: 5` shows the base image to level 5.
- **The sea** is the base image at every level: smooth and of one color when magnified, with no blotch or stripe
  (KB-237).
- **The package's WorldCover** covers the package's whole box, Europe and the land around it (European Turkey, North
  Africa, the Middle East's west), and its edges at the box fade out over 12 tile pixels (KB-231, KB-235). Its sea is
  transparent: the composite has real water only in the 1° cells that hold land and a flat no-data color beyond (RGB
  54, 73, 90), so every pixel of water's colors (blue and green above red, not bright) outside `EUROPE_LAND` is keyed
  out, fading back in over 4 km inside it (`keySea`, KB-303). The land, its coastline, lakes and shadows stay; beyond
  Europe's countries (Turkey, North Africa) the lakes go with the sea. From level 9 the package holds Europe's land
  only; elsewhere its level 8 tiles are magnified, so the land keeps the same source and colors.
- **Tones**: far away WorldCover is brightened toward the base image's tones, cell by cell, and never darkened; the
  match weakens with the zoom and is gone by level 9, where WorldCover shows its own colors (KB-234, KB-236). The online
  sources and the orthophotos are never matched: they show their own colors.
- **Online only** (no package), NASA's Blue Marble (500 m) fades in over the base image at level 4.5 to 5, in its own
  colors, for the land and the sea. GIBS serves it in EPSG:4326 only; the preset asks for one image per Web Mercator
  tile, drawn with its rows linear in latitude (KB-232). Beyond Web Mercator's 85.05° the caps take Natural Earth's
  colors (`polarCapColors`).
- **Above level 11** the tiles come from the online sources the application adds: `orthophotos` (each within its
  country's or region's borders, from level 12) and `addSources` with `minLevel` above 11, each asked for up to its
  own deepest level (`onlineMaxLevel` only lowers it). They fade in over level 12 to 13 in their own colors.
- **Without online sources** nothing is finer than the package's level 11 on land: beyond it the deepest tile is
  magnified with linear filtering, smooth and without blocks, but blurrier the closer the view (about 76 m a pixel of
  WorldCover at 45° N, so from level 14 a pixel of data covers 8 or more of the screen).
- **Terrain** is asked for no deeper than a tile the service reports missing: where Mapterhorn's data ends at level 13
  (parts of Italy), the first missing level answers 404 once per tile and no deeper level is asked for (F640, KB-238).
  `onlineMaxLevel: { 'europe-terrain': 13 }` stops at level 13 everywhere, with no 404 at all.
- **Loading** never shows a hole: the base image is under everything, the package's first level within its box is
  pinned and loads first (F634), and a tile still loading shows its ancestor.

To turn on every online source of the preset, add the orthophotos with `withAllOnlineSources`:

```ts
import { createGlobe } from '@vibeglobe/core';
import { createOffline } from '@vibeglobe/offline';
import { europeOpen } from '@vibeglobe/presets';
import { withAllOnlineSources } from '@vibeglobe/presets/orthophotos';
import { createWorkers } from '@vibeglobe/worker';

const preset = europeOpen(
  await withAllOnlineSources({
    packageManifestUrl: '/maps/europe/manifest.json',
    offline: createOffline({ mode: 'hybrid' }),
    farLevels: 4, // the base image to level 4 (the default)
  }),
);
const satellite = preset.baseMaps.find((b) => b.id === 'satellite');
const globe = createGlobe({
  container,
  renderer,
  workers: createWorkers(),
  baseImageryUrl: '/assets/natural-earth-4096.jpg',
  imagery: satellite?.imagery ?? [],
  ...(satellite?.polarCapColors ? { polarCapColors: satellite.polarCapColors } : {}),
});
```

A provider of your own for the levels above the package (with its key, never committed) joins with `addSources`,
`minLevel: 12` and its own `maxLevel`. Italy has no free orthophoto whose terms allow commercial use and
redistribution online yet (ADR 0182, open question 38): without one, Italy shows the package's level 11 magnified.

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
tiles everywhere and Mapterhorn's terrain over land. Satellite then shows NASA's Blue Marble up to its level 8, magnified
beyond it, and the application's own sources and orthophotos over it: no free detailed satellite imagery of Europe
could be verified for online use (ESA WorldCover's Terrascope service was left out, ADR 0182).

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
below it is used elsewhere. A paid provider of the customer's own (Google's Map Tiles API, a national agency's paid
service, …) is connected from the application's code through the generic adapters, with its key read from the
environment or the customer's configuration, never committed, and a profile with its terms:

```ts
import { createOffline } from '@vibeglobe/offline';
import { europeOpen } from '@vibeglobe/presets';
import { fetchTransport, withProfile, xyzImagery } from '@vibeglobe/sources';

// The customer's provider: its key added only when a tile is requested, its terms in its profile.
const provider = withProfile(
  xyzImagery({
    id: 'provider',
    url: 'https://tiles.provider.example/{z}/{x}/{y}.jpg',
    transport: fetchTransport(undefined, undefined, { secretQuery: () => ({ key: customerKey }) }),
  }),
  {
    id: 'provider',
    forbids: new Set(['persistentCache', 'offlinePackaging']),
    respectCacheHeaders: true,
    requiredAttribution: { text: 'Provider' },
  },
);
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
      source: provider,
      record: record('provider', 'Provider', "The provider's terms", 'https://provider.example/terms'),
      position: 'bottom',
    },
  ],
});
```

The provider's tiles are never packaged or cached persistently: its profile says so. The [sources guide](sources.md)
shows Google's Map Tiles API connected this way.

## National and regional orthophotos

`@vibeglobe/presets/orthophotos` adds the open orthophoto services whose terms were verified (ADR 0182): France (IGN),
Spain (PNOA), Portugal (DGT), the Netherlands (PDOK), Flanders, Wallonia, Luxembourg, Switzerland (SWISSIMAGE),
Austria (basemap.at), Czechia (ČÚZK), Poland (GUGiK), Croatia (DGU), Estonia, Finland, Alto Adige and twelve German
Länder (Bayern, Brandenburg and Berlin, Hamburg, Hessen, Mecklenburg-Vorpommern, Niedersachsen, Nordrhein-Westfalen,
Rheinland-Pfalz, Sachsen, Sachsen-Anhalt, Thüringen), from 19 to 21 levels deep. Each is a layer of its own, clipped
per pixel to its country's or region's borders (Natural Earth, loaded on demand), above the satellite composite;
outside them the composite shows. They are online services, asked tile by tile through their own APIs: they add nothing to the
package, and the offline engine's mode decides when they are asked (online and hybrid use ask them, offline use never,
KB-291). Each
starts at level 12 (`ORTHOPHOTO_MIN_LEVEL`), as the services answer far views with white images, and a white tile counts
as no data, so the composite shows through it.

```ts
import { europeOpen } from '@vibeglobe/presets';
import { europeOrthophotos } from '@vibeglobe/presets/orthophotos';

const orthophotos = await europeOrthophotos({ exclude: ['de-nw-dop'], onlineMaxLevel: { 'swisstopo-swissimage': 18 } });
const preset = europeOpen({ orthophotos });
const credits = preset.sources.filter((s) => s.kind === 'imagery').map((s) => s.attribution[0]?.text);
```

SWISSIMAGE is free under fair use (up to about 20,000 users a day), the Polish Geoportal bars bulk downloading, and
Finland's open interface is not meant for high-volume services; the other services publish no limit. Finland's and
Denmark's services need a key, free on registration with the National Land Survey and with Datafordeler: pass the
application's own as `europeOrthophotos({ keys: { 'fi-mml': key, 'dk-geodanmark': key } })`, without one the service
is left out. A credit carries the year the
data was read (`© IGN 2026 – BD ORTHO®`): update it with your own reading. The services left out, with why, are
`preset.excluded`: there is no open orthophoto service yet for Italy (except Alto Adige and the city of Bologna: AGEA's national imagery is CC BY 4.0 but
offered as downloads only, for an application's own package), the United Kingdom, Ireland, Norway, Sweden, most of
Central and Eastern Europe and the Balkans, nor a Europe-wide one; there the
package's WorldCover composite is the detail (below).

## Maximum online zoom per area

The deepest level asked for online, by area and source, with the default options (`onlineMaxLevel` lowers them).
Beyond it the deepest tile is magnified.

| Area                                                                                                                                                                                                                                                               | Satellite                                                                                      | Map, labels, roads, buildings                       | Terrain and relief                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| Land in Europe                                                                                                                                                                                                                                                     | Blue Marble to 8 online; the package's WorldCover from 5 to 11                                 | 14 (OpenFreeMap; the package first up to 11)        | 17 (Mapterhorn, where it holds them; the package first up to 11) |
| Sea in Europe                                                                                                                                                                                                                                                      | Blue Marble to 8 online                                                                        | none in hybrid; the package up to 8, then magnified | none online; the package up to 8                                 |
| Outside Europe                                                                                                                                                                                                                                                     | Blue Marble to 8                                                                               | 14 (OpenFreeMap)                                    | none                                                             |
| France, Spain, mainland Portugal, Netherlands, Belgium but Brussels, Luxembourg, Switzerland, Austria, Czechia, Poland, Croatia, Estonia, Finland (with a key), Alto Adige, twelve German Länder (all but Baden-Württemberg, Bremen, Saarland, Schleswig-Holstein) | with `europeOrthophotos()`: from 12 to 18–21, the service's own levels, clipped to its borders | as land in Europe                                   | as land in Europe                                                |

Every source is asked for up to its own deepest level, and beyond it its deepest tile is magnified without a stop: the
preset sets no zoom limit. Mapterhorn's tiles are asked for down to level 17; where it holds no deeper tile, its deepest one is magnified. OpenFreeMap's vector tiles stop at level 14 and are
overzoomed beyond.

## Building the package

The pipeline configuration `packages/tools/configs/europe.json` builds the package from the same sources as the
preset, with the same ids (`europe-satellite`, `europe-terrain`, `europe-vectors`):

- `region` is Europe's bounding box (32° W to 45° E, 27° N to 72° N) and `land` the Natural Earth 1:50m land mask of
  Europe (`regions/europe-land.geojson`, made by `scripts/europe-land.ts`);
- each dataset's `minZoom` and `maxZoom` set the levels on land (5 to 11, the owner's choice of 2026-10-27) and `seaMaxZoom` the deepest level over the sea (8):
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
`europe.json` without `--measure` (2026-10-27; its satellite sizes are the averages measured below, the vector and
terrain sizes configured, as the archive hosts were not reachable from the build machine):

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
package together. The imagery's download is the Sentinel-2 source files it reads from, with range requests, so far
less than their full size is transferred. Lower a dataset's `maxZoom` to trade detail for size: each level is about
four times the one before it.

### The WorldCover package by its deepest level

The satellite package's size if built to each level from 10 to 13, on land (the sea stops at 8), from real WorldCover
tiles measured on 2026-10-27: the tiles of six land areas (the Alps around Mont Blanc, the Beauce, Paris, the Po
valley, the Spanish Meseta, a Swedish forest; about 30 tiles per area and level) built by the pipeline and averaged.
Levels 5 to 9 add about 0.14 GB. One copy, in decimal gigabytes.

| Deepest level | Land tiles at that level | Average tile | That level | Package (levels 5 to it) |
| ------------- | ------------------------ | ------------ | ---------- | ------------------------ |
| 10            | 17,398                   | 25.4 kB      | 0.44 GB    | 0.58 GB                  |
| 11 (default)  | 66,781                   | 24.3 kB      | 1.62 GB    | 2.20 GB                  |
| 12            | 260,558                  | 22.0 kB      | 5.72 GB    | 7.93 GB                  |
| 13            | 1,028,226                | 18.6 kB      | 19.09 GB   | 27.0 GB                  |

Tiles get smaller with depth (the composite's 10 m pixels are smoother at level 13), and they vary with the landscape:
an Alpine tile at level 10 weighs 31.6 kB, a field in the Beauce 21.0 kB. `europe.json` uses these averages as its
`bytesPerTile`.

Built deeper, tell the preset: `europeOpen({ packageLevels: { imagery: 13 } })` reads the package's satellite imagery
to level 13 (F662). Level 13 holds WorldCover's 10 m detail in full, so where no orthophoto covers the land (Italy, the
United Kingdom, Scandinavia, the Balkans) zoom 15 shows it magnified four times instead of level 11 sixteen times; the
orthophotos still fade in from level 12 above it.

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
