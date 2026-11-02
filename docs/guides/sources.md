---
title: Sources and adapters
---

# Sources and adapters

A globe reads every tiled layer through a source: an object that implements `ImagerySource` or `TerrainSource` of
`@vibeglobe/core`. `@vibeglobe/sources` builds sources from URL templates, OGC services, PMTiles and MBTiles packages
and single images, attaches their credits and provider profiles, and ships conformance suites for your own adapters.
Use `@vibeglobe/offline` to cache and package tiles ([offline guide](offline.md)), the [terrain guide](terrain.md) for
heights and the camera, the [hosting guide](hosting.md) to serve the files, and the
[vector tiles guide](vector-tiles.md) for styled vector maps.

## Quick start

```ts
import { createGlobe, type WorkerEndpointFactory } from '@vibeglobe/core';
import { xyzImagery } from '@vibeglobe/sources';

declare const baseImageryUrl: string;
declare const workers: WorkerEndpointFactory; // createWorkers() of @vibeglobe/worker

const base = xyzImagery({ id: 'base', url: 'https://tiles.example.com/{z}/{x}/{y}.png', maxLevel: 18 });
createGlobe({ container, renderer, baseImageryUrl, workers, imagery: [base] });
```

`createGlobe` takes sources in `imagery` (layers, bottom first) and one source in `terrain`; both need `workers`.

## The adapter interface

A tiled source is a plain object; the engine needs nothing else from it:

```ts
import { WEB_MERCATOR_TILING, type ImagerySource } from '@vibeglobe/core';
import { CUSTOM_PROFILE, fetchTransport, withProfile } from '@vibeglobe/sources';

const plain: ImagerySource = {
  id: 'my-tiles', // unique per engine instance
  tiling: WEB_MERCATOR_TILING, // or GEOGRAPHIC_TILING, the two-root plate carrée pyramid
  minLevel: 0,
  maxLevel: 16,
  tileSizePx: 256,
  pixelRatio: 1, // 2 for @2x tiles
  decoder: 'image', // or 'ktx2'
  transport: fetchTransport(),
  request(coord, out) {
    if (coord.level > 16) return 'noData'; // a tile that never exists is never requested
    out.url = `https://tiles.example.com/${coord.level}/${coord.x}/${coord.y}.png`;
    out.hostIndex = 0;
    return out;
  },
};
const mine = withProfile(plain, CUSTOM_PROFILE, [{ text: '© My tiles', url: 'https://tiles.example.com/' }]);
```

- `request(coord, out, pixelRatio?)` writes the tile's URL and host into `out` and returns it, or returns `'noData'`
  (never requested) or `'unknown'` (asked again later, while availability is not known yet).
- `withProfile(source, profile, attribution?)` adds `attribution` and `profile`, puts the profile's required credit
  first when `attribution` lacks it, and caps `maxRequestsPerHost` at the profile's `maxConcurrentRequests`.
- A terrain source (`TerrainSource`) adds `decoder` (`terrarium`, `terrain-rgb`, `quantized-mesh` or
  `{ kind: 'custom', decode }`), `datum` and `geometricErrorMeters(level)`.

## Imagery adapters

```ts
import { createGlobe, type WorkerEndpointFactory } from '@vibeglobe/core';
import { pmtilesImagery, wmsImagery, wmtsImagery, xyzImagery } from '@vibeglobe/sources';
import { mbtilesImagery } from '@vibeglobe/sources/mbtiles';

declare const baseImageryUrl: string;
declare const workers: WorkerEndpointFactory;

const xyz = xyzImagery({ id: 'base', url: 'https://tiles.example.com/{z}/{x}/{y}.png', maxLevel: 18 });
const wmts = await wmtsImagery({
  id: 'ortho',
  capabilities: 'https://wmts.example.com/WMTSCapabilities.xml',
  layer: 'ortho',
});
const wms = await wmsImagery({
  id: 'labels',
  capabilities: 'https://wms.example.com/?SERVICE=WMS&REQUEST=GetCapabilities',
  layers: ['labels'],
});
const archive = await pmtilesImagery({ id: 'italy', archive: 'https://cdn.example.com/italy.pmtiles' });
const lan = await mbtilesImagery({
  id: 'nas',
  package: 'http://nas.local/italy.mbtiles',
  wasmUrl: '/assets/sql-wasm.wasm',
});

createGlobe({ container, renderer, baseImageryUrl, workers, imagery: [xyz, wmts, archive, lan, wms] });
```

| Adapter                                         | Reads                                                                 | Returns                           |
| ----------------------------------------------- | --------------------------------------------------------------------- | --------------------------------- |
| `xyzImagery`                                    | an XYZ or TMS URL template                                            | `ImagerySource`                   |
| `wmtsImagery`                                   | WMTS 1.0.0 capabilities (URL or XML text), RESTful or KVP tiles       | `Promise<DescribedImagerySource>` |
| `wmsImagery`                                    | WMS 1.1.1 or 1.3.0 GetMap, one image per tile                         | `Promise<DescribedImagerySource>` |
| `pmtilesImagery`                                | a PMTiles v3 raster archive: a URL (range requests), `File`, `Blob`   | `Promise<DescribedImagerySource>` |
| `mbtilesImagery` (`@vibeglobe/sources/mbtiles`) | an MBTiles package: a URL downloaded whole, `File`, `Blob`            | `Promise<DescribedImagerySource>` |
| `singleImage`, `geotiffImage`, `mercatorImage`  | one georeferenced image ([below](#single-georeferenced-images))       | see below                         |
| `reprojectedImagery`                            | an image service in another reference system ([below](#reprojection)) | `ImagerySource`                   |

- `wmtsImagery` takes the layer's default style, the first format of PNG, JPEG and WebP, and the first tile matrix
  set that lines up with `preferredCrs` (`EPSG:3857` by default, or `EPSG:4326`). `dimensions` sets values such as
  `{ Time: '2024-01-01' }`; each dimension's default applies otherwise. `encoding` is RESTful when the layer has a
  resource URL, else KVP.
- `wmsImagery` asks for version 1.3.0 unless the capabilities say otherwise, with `transparent: true` and a 32 px
  gutter cropped away (`gutterPx`), so labels at a tile edge are drawn whole. An XML service exception fails the tile
  for good. `parameters` adds vendor parameters such as `TIME`.
- `pmtilesImagery` reads the header and directories once and caches them; levels, bounds and attribution come from
  the archive. `headers`, `credentials` and `fetch` apply to its range requests; `maxRequestsPerHost` is 6.
- `mbtilesImagery` reads the plain `tiles` table and the deduplicated `map` and `images` schema. It needs `wasmUrl`,
  the URL of `sql-wasm.wasm` from the `sql.js` package, which the application hosts; Node finds the file itself.

## Terrain adapters

```ts
import { heightmapTerrain, pmtilesTerrain, quantizedMeshTerrain } from '@vibeglobe/sources';
import { mbtilesTerrain } from '@vibeglobe/sources/mbtiles';

const terrarium = heightmapTerrain({
  id: 'dem',
  url: 'https://dem.example.com/{z}/{x}/{y}.png',
  encoding: 'terrarium',
});
const terrainRgb = heightmapTerrain({
  id: 'dem-rgb',
  url: 'https://dem.example.com/rgb/{z}/{x}/{y}.png',
  encoding: 'terrain-rgb',
  attribution: [{ text: '© Terrain provider' }],
});
const mesh = await quantizedMeshTerrain({ id: 'mesh', url: 'https://dem.example.com/mesh/layer.json' });
const packaged = await pmtilesTerrain({
  id: 'alps',
  archive: 'https://cdn.example.com/alps.pmtiles',
  encoding: 'terrarium',
});
const onTheNas = await mbtilesTerrain({
  id: 'nas-dem',
  package: 'http://nas.local/alps-dem.mbtiles',
  encoding: 'terrarium',
  wasmUrl: '/assets/sql-wasm.wasm',
});
```

- `heightmapTerrain` reads Terrarium or Terrain-RGB PNG tiles, levels 0 to 15 by default, 256 px (or `tileSizePx: 512`).
- `quantizedMeshTerrain` reads `layer.json` (tiling, levels, URL templates, extensions, availability) before it resolves.
- `pmtilesTerrain` and `mbtilesTerrain` take `encoding`: `terrarium`, `terrain-rgb` or `quantized-mesh`.
- Heights are metres above the WGS84 ellipsoid unless the source declares a geoid `datum` ([terrain guide](terrain.md)).

## Vector tiles in packages

```ts
import { pmtilesVector } from '@vibeglobe/sources';
import { decodeMvt } from '@vibeglobe/sources/vector';

const roads = await pmtilesVector({ id: 'roads', archive: 'https://cdn.example.com/roads.pmtiles' });
const request = roads.request({ root: 0, level: 3, x: 4, y: 2 }, { url: '', hostIndex: 0 });
if (typeof request === 'object')
  roads.transport.start(request, { firstByteMs: 10_000, totalMs: 30_000 }, (result) => {
    if (result.kind === 'ok') console.log(decodeMvt(new Uint8Array(result.bytes))?.layers.length);
  });
```

`pmtilesVector` and `mbtilesVector` return a `VectorTileSource` of Mapbox Vector Tiles (`format: 'mvt'`) from a URL, a
local file or, wrapped by `offline.source()`, browser storage.

## Single georeferenced images

```ts
import { singleImage } from '@vibeglobe/sources';
import { geotiffImage } from '@vibeglobe/sources/geotiff';

// Bounds are west, south, east, north in the units of `crs` (EPSG:4326 degrees by default).
const flood = await singleImage({
  id: 'flood-map',
  image: 'https://images.example.com/flood.png',
  bounds: [12.3, 41.7, 12.7, 42.0],
  attribution: [{ text: '© Civil protection' }],
});
const scan = await singleImage({
  id: 'scan',
  image: 'https://images.example.com/scan.jpg',
  crs: 'EPSG:3857',
  worldFile: '10\n0\n0\n-10\n1380000.5\n5150000.5\n',
});
const survey = await geotiffImage({ id: 'survey', image: 'https://images.example.com/survey.tif' });
```

- `singleImage` places a PNG, JPEG or WebP by `bounds` or by the text of a world file (`.pgw`, `.jgw`, `.wld`), in
  `EPSG:4326`, `EPSG:3857` or any system `transforms` knows. `geotiffImage` reads the placement from the GeoTIFF's tags.
- The image is downloaded and decoded once; each engine tile draws its own piece, so an image larger than the GPU's
  texture limit shows whole.
- Without `sizePx`, and without both `bounds` and `maxLevel`, the factory downloads the image to read its size. With
  them the image downloads with the first tile, so a hidden layer costs nothing until shown.
- `maxLevel` defaults to one level finer than the image's own resolution.

`mercatorImage` shows one image of the whole Web Mercator square (180° W to 180° E, about 85.05° S to 85.05° N), such
as night lights seen from afar. It downloads the image with the first tile, decodes it once and cuts the tiles of
levels 0 to `maxLevel` (0 to 22) from it; the engine enlarges finer levels. A failed download is tried again with the
next tile. For an image of part of the world, use `singleImage` with `crs: 'EPSG:3857'`.

```ts
import { mercatorImage } from '@vibeglobe/sources';

// 2048 pixels wide: levels 0 to 3 are cut at full resolution.
const lights = mercatorImage({
  id: 'night-lights',
  image: 'https://images.example.com/night-lights.webp',
  maxLevel: 3,
  attribution: [{ text: 'Night lights: NASA Black Marble' }],
});
// A layer of its own: globe.imageryLayers.add({ id: 'night-lights', blend: 'night', sources: [lights] }).
```

## Reprojection

The engine draws Web Mercator and geographic pyramids. A service in another reference system, such as UTM zones 32N
and 33N (`EPSG:32632`, `EPSG:32633`) or a custom WMTS tile matrix set, is reprojected on the client: each engine tile
asks for the source image covering it (a WMS GetMap, or WMTS tiles composed in place) and warps it piecewise-affinely.

```ts
import { transformCoordinates } from '@vibeglobe/gis';
import { reprojectedImagery, wmsGetMapUrl, wmtsImagery } from '@vibeglobe/sources';

const transforms = (crs: string) =>
  crs === 'EPSG:32632'
    ? {
        toSource: (lon: number, lat: number): [number, number] => {
          const p = transformCoordinates({ x: lon, y: lat }, 'EPSG:4326', crs);
          return [p.x, p.y];
        },
        fromSource: (x: number, y: number): [number, number] => {
          const p = transformCoordinates({ x, y }, crs, 'EPSG:4326');
          return [p.x, p.y];
        },
      }
    : undefined;
// A WMTS layer whose only tile matrix set is in UTM 32N.
const utmWmts = await wmtsImagery({
  id: 'utm',
  capabilities: 'https://wmts.example.com/WMTSCapabilities.xml',
  layer: 'utm-only',
  transforms,
});
// Any image service: `bounds` in its units, `image` returns the URL of the picture of a box.
const pair = transforms('EPSG:32632');
if (pair)
  reprojectedImagery({
    id: 'orthophoto-32n',
    sourceCrs: 'EPSG:32632',
    ...pair,
    bounds: [300000, 4000000, 800000, 5200000],
    image: (bbox, widthPx, heightPx) =>
      wmsGetMapUrl('https://wms.example.com/', { layers: ['ortho'], crs: 'EPSG:32632', bbox, widthPx, heightPx }),
    attribution: [{ text: '© Ortho provider' }],
  });
```

`wmtsImagery`, `wmsImagery`, `singleImage` and `geotiffImage` take the same `transforms`. Reprojected tiles are
transparent outside the data, so the layers below show there.

## Polar caps

Web Mercator sources end at ±85.0511°. Beyond, the globe draws two polar caps: a geographic (`EPSG:4326`) imagery
source that covers them fills them; otherwise each cap shows one color, `#78a9cd` in the north and `#f2f3f7` in the
south (the sea and the ice of the default base image).

```ts
import { createGlobe } from '@vibeglobe/core';

declare const baseImageryUrl: string;

const globe = createGlobe({ container, renderer, baseImageryUrl, polarCapColors: { north: '#0b2a4a' } });
globe.setPolarCapColors({ north: '#1d3d5f', south: '#ffffff' });
```

Colors are `#rrggbb`; another value throws a `GlobeError` with code `invalid-option`. A view that reaches a cap stays a
globe at every zoom, so the cap is always a whole disc.

## Layer composition and source chains

`createGlobe({ imagery })` takes layers bottom first. A layer is a source, or `{ id, sources, opacity, visible, blend }`
with sources in priority order: each tile comes from the first source that has it, and a source that fails (errors,
timeouts, offline) leaves its tiles to the next one.

```ts
import { createGlobe, type WorkerEndpointFactory } from '@vibeglobe/core';
import { xyzImagery } from '@vibeglobe/sources';

declare const baseImageryUrl: string;
declare const workers: WorkerEndpointFactory;

const offlineBase = xyzImagery({ id: 'lan-base', url: 'http://nas.local/tiles/{z}/{x}/{y}.png', maxLevel: 8 });
const onlineBase = xyzImagery({ id: 'cdn-base', url: 'https://tiles.example.com/{z}/{x}/{y}.png', maxLevel: 18 });
const labels = xyzImagery({ id: 'labels', url: 'https://labels.example.com/{z}/{x}/{y}.png' });

const globe = createGlobe({
  container,
  renderer,
  baseImageryUrl,
  workers,
  imagery: [
    { id: 'base', sources: [offlineBase, onlineBase] }, // the LAN first, the CDN where it has nothing
    { id: 'labels', sources: [labels], opacity: 0.8, blend: 'multiply' },
  ],
});
globe.imageryLayers.set('labels', { visible: false }); // a hidden layer requests no tiles
globe.imageryLayers.move('labels', 0);
```

- Blend modes are `normal` (default), `multiply`, `screen` and `night`. A `night` layer adds light on the night side
  ([space background guide](space-background.md#day-and-night-and-a-clearer-globe-from-afar)).
- Each surface tile shows the topmost opaque layer that has a tile for it, with at most two translucent or blended
  layers above it.
- `globe.imageryLayers` also has `add(layer, index?)`, `remove(id)` and `list()`.

A source limited to a country or a region takes `coverage` or `area`:

| Option                                 | Tiles requested               | Border pixels                                          |
| -------------------------------------- | ----------------------------- | ------------------------------------------------------ |
| `coverage`: rectangles, in radians     | those overlapping a rectangle | as the service sends them                              |
| `area: { polygons }` (degrees)         | only those wholly inside      | the next source, or the layer below, shows at the edge |
| `area: { polygons, tiles: 'overlap' }` | every tile touching the area  | as the service sends them (for transparent tiles)      |
| `area` as GeoJSON, or `tiles: 'clip'`  | every tile touching the area  | transparent outside the area                           |

GeoJSON is a `Polygon`, `MultiPolygon`, `Feature` or `FeatureCollection`. A clipped source becomes transparent, so the
layer below shows outside the area instead of the white or black filler many national services send. Put such a
source in its own layer above the fallback: a layer draws each tile from one source. `countryBorders('AT')` of
`@vibeglobe/presets/countries` resolves a European country's borders as GeoJSON. `blankTile` is the fallback when the
area is not known: a tile of that color alone counts as no data. `blankShare` below 1 counts a tile mostly of that
color as no data too: a filler with a caption, such as Esri's "Map data not yet available" (`#cccccc`, `0.9`). The
engine then shows the deepest level the service has, magnified.

`keySea: { land, featherMeters }` in an `area` keys the sea out of imagery: pixels of water's colors outside `land`
(polygons in degrees, such as `WORLD_LAND` of `@vibeglobe/presets/world-land`) become transparent, so one sea, the
layer below, shows everywhere. Inside the land water stays (lakes, shadows), fading out over `featherMeters` toward
the outline. For imagery whose water is real everywhere, such as an online satellite service, add `offshoreMeters`:
water stays up to that distance beyond the land and fades out there, so the coast keeps its own water whatever the
outline's precision, and the tiles within that distance of the land are requested too. A source keying the sea is
transparent.

```ts
import { createGlobe, type WorkerEndpointFactory } from '@vibeglobe/core';
import { xyzImagery } from '@vibeglobe/sources';

declare const baseImageryUrl: string;
declare const workers: WorkerEndpointFactory;

const world = xyzImagery({ id: 'world', url: 'https://world.example.com/{z}/{x}/{y}.jpg', maxLevel: 9 });
const national = xyzImagery({
  id: 'national-ortho',
  url: 'https://ortho.example.com/{z}/{x}/{y}.jpg',
  maxLevel: 19,
  area: {
    type: 'Polygon',
    coordinates: [
      [
        [9.5, 46.4],
        [17.2, 46.4],
        [17.2, 49.0],
        [9.5, 49.0],
        [9.5, 46.4],
      ],
    ],
  },
});
const legacy = xyzImagery({ id: 'legacy', url: 'https://legacy.example.com/{z}/{x}/{y}.png', blankTile: '#ffffff' });

createGlobe({
  container,
  renderer,
  baseImageryUrl,
  workers,
  imagery: [
    { id: 'world', sources: [world] },
    { id: 'national', sources: [national] },
    { id: 'legacy', sources: [legacy] },
  ],
});
```

## Vector formats

`@vibeglobe/sources/vector` exports the parsers and `VECTOR_TASKS`, the task table the worker program registers.

```ts
import { decodeMvt, parseGeoJson, parseGpx, parseKml } from '@vibeglobe/sources/vector';

declare const text: string;
declare const kmzBytes: Uint8Array;
declare const bytes: Uint8Array;

const { features, issues } = parseGeoJson(text); // every geometry type; invalid features listed in `issues`
const kml = parseKml(kmzBytes); // KML or KMZ: placemarks, styles, folders, ground overlays, images in `resources`
const gpx = parseGpx(text); // waypoints, routes and tracks with elevation and time
const tile = decodeMvt(bytes); // layers and features in tile coordinates, or undefined for a malformed tile
```

No parser throws: a malformed document gives an empty result with its issue.

## Provider profiles

**Your application is responsible for its map data.** VibeGlobe grants no right to any map, image or elevation data,
and its maintainers give no legal advice. The application chooses its sources, holds their keys, accepts their terms,
pays for them and checks that its use is allowed. A profile is the application's reading of a provider's terms, which
the library then enforces. [Data licenses](../data-licenses.md) lists the terms of the default datasets as read on
their dates, to help that check.

A profile only switches features off, and only for its own source. Every loading feature (persistent cache, memory
reuse, prefetch and flight preloading, offline packaging) is on by default. `@vibeglobe/offline` can switch off more,
globally or per source, and switches on nothing a profile forbids.

| `ProviderProfile` field | Effect                                                                    | Enforced by                      |
| ----------------------- | ------------------------------------------------------------------------- | -------------------------------- |
| `id`                    | names the profile in warnings and errors                                  | —                                |
| `forbids`               | `persistentCache`, `memoryReuse`, `prefetch`, `offlinePackaging` stay off | `@vibeglobe/offline` only        |
| `respectCacheHeaders`   | responses are reused only while their cache headers allow it              | the engine, `@vibeglobe/offline` |
| `maxConcurrentRequests` | caps the source's `maxRequestsPerHost`                                    | `withProfile`                    |
| `requiredAttribution`   | a credit always shown, also when the source is in `hiddenCredits`         | the engine                       |
| `displayOnly`           | pixel readback, tile data and elevation sampling throw `display-only`     | the engine                       |
| `warning`               | logged once per engine instance                                           | the engine                       |
| `termsAdr`              | recorded for the application                                              | —                                |

### Your own provider's profile

```ts
import { combineProfiles, withProfile, xyzImagery, type ProviderProfile } from '@vibeglobe/sources';

const acme: ProviderProfile = {
  id: 'acme',
  forbids: new Set(['persistentCache', 'offlinePackaging']),
  respectCacheHeaders: true,
  maxConcurrentRequests: 4,
  requiredAttribution: { text: 'Acme Maps', logo: { src: '/assets/acme.png', alt: 'Acme' } },
  termsAdr: 'docs/terms/acme.md',
};
const acmeTiles = withProfile(xyzImagery({ id: 'acme', url: 'https://tiles.acme.example/{z}/{x}/{y}.png' }), acme);
// A provider serving someone else's data: both sets of terms at once.
const strictest = combineProfiles(acme, { id: 'reseller', forbids: new Set(['prefetch']), respectCacheHeaders: true });
```

`combineProfiles(inner, outer)` forbids what either forbids, keeps the lower `maxConcurrentRequests`, respects cache
headers and is `displayOnly` when either asks, carries both warnings, and takes `outer`'s required credit (else
`inner`'s).

### Commercial providers, from your own code

VibeGlobe ships no adapter of a paid or proprietary service. An application with its own contract (Google's Map Tiles
API, a national mapping agency's paid service, …) connects it through the generic adapters, with its own key and a
profile of the provider's terms. The key and the session stay in the transport, which adds them only when a request
is made. For Google's 2D tiles, for example:

```ts
import { fetchTransport, withProfile, xyzImagery, type ProviderProfile } from '@vibeglobe/sources';

declare const myRestrictedKey: string;

// Your reading of the provider's terms.
const googleTerms: ProviderProfile = {
  id: 'google',
  forbids: new Set(['persistentCache', 'prefetch', 'offlinePackaging']),
  respectCacheHeaders: true,
  displayOnly: true,
  requiredAttribution: { text: 'Google Maps', logo: { src: '/assets/google-logo.png', alt: 'Google Maps' } },
  termsAdr: 'docs/terms/google.md',
};
// A session started with the first tile.
let session: Promise<string> | undefined;
const sessionToken = (): Promise<string> =>
  (session ??= fetch(`https://tile.googleapis.com/v1/createSession?key=${myRestrictedKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mapType: 'roadmap', language: 'it-IT', region: 'IT' }),
  })
    .then((response) => response.json() as Promise<{ session: string }>)
    .then((answer) => answer.session));
// The URLs the engine sees, logs and shows carry neither the session nor the key.
const transport = fetchTransport(async (input, init) =>
  fetch(`${String(input)}?session=${await sessionToken()}&key=${myRestrictedKey}`, init),
);
const google = withProfile(
  xyzImagery({ id: 'google', url: 'https://tile.googleapis.com/v1/2dtiles/{z}/{x}/{y}', transport }),
  googleTerms,
);
```

Photorealistic 3D Tiles follow the same pattern: `tiles3d({ url, meshes, transport, profile })` of
`@vibeglobe/sources/tiles3d`, added with `globe.addRenderExtension`, takes the root tileset's URL, the meshes of
`@vibeglobe/renderer/tiles3d` (`threeTileMeshes`), your transport and your profile; its `copyrights()` lists the
credits of the tiles drawn. A provider whose credits change with the view updates the source's `attribution` and calls
`globe.refreshCredits()` when the view settles (`globe.on('idle', …)`). Which terms apply, in which billing region, and
whether a key may be used in a browser are between you and the provider.

### OpenStreetMap public servers

```ts
import { openStreetMapImagery } from '@vibeglobe/sources';

const osm = openStreetMapImagery({ appName: 'My demo', appUrl: 'https://demo.example.com/' });
```

**The OpenStreetMap Foundation's public tile servers are unsuitable for production products.** They run on donated
capacity for light use. `OSM_PUBLIC_PROFILE` keeps at most 2 requests in flight, identifies the application on every
request, forbids prefetch, persistent caching and offline packaging, and logs one warning per engine instance. A `url`
with `{s}` or the retired `a.`, `b.` and `c.` hosts is refused. Products serve tiles built from an
OpenStreetMap extract by the data pipeline (`vibeglobe-data`, [hosting guide](hosting.md)).

### Self-hosted OpenStreetMap tiles

```ts
import { openStreetMapHostedImagery } from '@vibeglobe/sources';

const own = openStreetMapHostedImagery({ id: 'osm', url: 'https://tiles.mycompany.example/{z}/{x}/{y}.png' });
const viaProvider = openStreetMapHostedImagery({
  id: 'osm-provider',
  url: 'https://maps.provider.example/{z}/{x}/{y}.png',
  provider: {
    id: 'maps-inc',
    forbids: new Set(['offlinePackaging']),
    respectCacheHeaders: true,
    requiredAttribution: { text: '© Maps Inc.' },
  },
});
```

Self-hosted OpenStreetMap tiles (`OSM_SELF_HOSTED_PROFILE`) enable every feature and show "© OpenStreetMap
contributors, ODbL" linked to the copyright page. A commercial provider's profile in `provider` adds its rules and its
credit on top.

### Apple map data

Apple's map data may only be used through Apple's own MapKit, so VibeGlobe offers no Apple adapter.

## Keeping secrets out of URLs

Send credentials in headers where the provider supports them (`headers` on `xyzImagery`, `pmtilesImagery` and
`mbtilesImagery`). `fetchTransport(fetchImpl?, headers?, extras?)` restricts them to origins, renews them, and adds a
key the provider requires in the URL only when the request is made:

```ts
import { fetchTransport, xyzImagery } from '@vibeglobe/sources';

declare const session: { token: string; renew(): Promise<void> };
declare const myRestrictedKey: string;

const transport = fetchTransport(undefined, undefined, {
  // Sent only to these origins; renewed once when the server answers 401 or 403.
  auth: {
    origins: ['https://tiles.example.com'],
    headers: () => ({ Authorization: `Bearer ${session.token}` }),
    refresh: () => session.renew(),
  },
  // A key the provider insists on in the URL.
  secretQuery: () => ({ key: myRestrictedKey }),
  credentials: 'omit', // the fetch credentials mode (cookies); 'omit' by default
});
const imagery = xyzImagery({ id: 'tiles', url: 'https://tiles.example.com/{z}/{x}/{y}.png', transport });
```

The engine never sees the `secretQuery` values or the headers, so its logs, traces, errors and debug overlay cannot
show them. When your own code logs URLs, pass them through `redactUrl`, which replaces the values of query parameters
named like keys, tokens, signatures and sessions with `***`.

## Writing and testing a custom adapter

An adapter is any object that implements `ImagerySource`; `withProfile` turns it into a `DescribedImagerySource`, so
the engine credits it and the library enforces its terms. `@vibeglobe/sources/conformance` runs the shared checks
without a test framework and returns every check with its outcome; `failures(results)` lists the failed ones:

```ts
import type { DescribedImagerySource } from '@vibeglobe/sources';
import { failures, runTiledConformance } from '@vibeglobe/sources/conformance';

declare const myAdapter: (options: { fetch: typeof fetch }) => DescribedImagerySource;
declare const myRecordedService: typeof fetch; // answers like the real service

const results = await runTiledConformance({
  name: 'my adapter',
  create: (fetchImpl) => myAdapter({ fetch: fetchImpl }),
  fixture: myRecordedService,
  tiles: [{ coord: { root: 0, level: 3, x: 4, y: 2 } }],
  missing: [{ root: 0, level: 3, x: 5, y: 2 }],
});
if (failures(results).length > 0) throw new Error(failures(results).join('\n'));
```

The tiled suite checks metadata, tile addressing, coverage, the zoom range, 404 and 500 answers, timeouts, corrupted
payloads, cancellation, attribution and the profile's rules (concurrency, required credit and logo, and your
`profileChecks`). `runTerrainConformance` adds decoded heights at reference points:

```ts
import { fetchTransport, heightmapTerrain } from '@vibeglobe/sources';
import { failures, runTerrainConformance } from '@vibeglobe/sources/conformance';

declare const myRecordedService: typeof fetch;
// RGBA of a heightmap tile, for tests in Node; in the browser the engine decodes images.
declare const myPngDecoder: (bytes: Uint8Array) => { rgba: Uint8Array; sizePx: number };

const terrainResults = await runTerrainConformance({
  name: 'my terrain',
  create: (fetchImpl) =>
    heightmapTerrain({
      id: 'dem',
      url: 'https://dem.example.com/{z}/{x}/{y}.png',
      encoding: 'terrarium',
      transport: fetchTransport(fetchImpl),
    }),
  fixture: myRecordedService,
  tiles: [{ coord: { root: 0, level: 3, x: 4, y: 2 } }],
  heights: [{ coord: { root: 0, level: 3, x: 4, y: 2 }, u: 0.5, v: 0.5, meters: 120, toleranceMeters: 0.5 }],
  decodeImage: myPngDecoder,
});
if (failures(terrainResults).length > 0) throw new Error(failures(terrainResults).join('\n'));
```

`runParserConformance` checks a parser against fixtures and fuzzes it.

## Options

The options of `xyzImagery`, the adapter most layers use. The TSDoc of each adapter's options type lists the rest.

| Option                 | Type                          | Default            | Effect                                                      |
| ---------------------- | ----------------------------- | ------------------ | ----------------------------------------------------------- |
| `id`                   | `string`                      | required           | unique per engine instance                                  |
| `url`                  | `string`                      | required           | template: `{z}`, `{x}`, `{y}` or `{-y}` (TMS), `{s}`, `{r}` |
| `tiling`               | `'mercator' \| 'geographic'`  | `'mercator'`       | Web Mercator, or the two-root geographic pyramid            |
| `minLevel`, `maxLevel` | `number`                      | `0`, `19`          | levels outside are never requested                          |
| `tileSizePx`           | `number`                      | `256`              | tile edge in pixels                                         |
| `pixelRatio`           | `number`                      | `1`                | `2` for tiles that are always `@2x`                         |
| `subdomains`           | `string[]`                    | none               | values of `{s}`, spread over tiles                          |
| `coverage`             | `TileRectangleRad[]`          | none               | rectangles in radians; tiles outside are never requested    |
| `area`                 | `CoverageArea \| GeoJsonArea` | none               | polygons in degrees (table above)                           |
| `blankTile`            | `#rrggbb` or `[r, g, b]`      | none               | a tile of this color alone counts as no data                |
| `blankShare`           | `number` in (0, 1]            | `1`                | the share of a tile's pixels of `blankTile` for no data     |
| `transparent`          | `boolean`                     | `false`            | the tiles have transparent areas                            |
| `headers`              | `Record<string, string>`      | none               | sent with every request by the default transport            |
| `transport`            | `TileTransport`               | `fetchTransport()` | replaces `headers`                                          |
| `maxRequestsPerHost`   | `number`                      | `6` (`16`)         | requests in flight per host; 16 with `multiplexed`          |
| `maxRequestsPerSecond` | `number`                      | none               | the engine never starts more in any second                  |
| `timeoutsMs`           | `{ firstByteMs, totalMs }`    | 10 s, 30 s         | time to the headers, and in all                             |
| `attribution`          | `Attribution[]`               | none               | credits shown while its tiles are in view                   |
| `profile`              | `CreditProfile`               | none               | credit rules only; use `withProfile` for a full profile     |

`{r}` becomes `@2x` on high-DPI canvases and nothing elsewhere. `{s}` without `subdomains` is refused.

## Rules and pitfalls

- `coverage` is in radians and `area` in degrees: degrees in `coverage` make the source request almost nothing.
- A plain `area: { polygons }` requests only tiles wholly inside it: give GeoJSON or `tiles: 'clip'` to draw the
  source up to the border.
- `forbids` takes effect only for sources wrapped by `offline.source()`: without `@vibeglobe/offline` the engine keeps
  tiles in memory and prefetches whatever the profile says.
- `xyzImagery`'s `profile` option is a `CreditProfile`; `withProfile` adds the full `ProviderProfile`, caps the
  concurrency and adds the required credit.
- A source with invalid metadata (levels outside 0 to 30 or inverted, a tile size that is not a positive integer, a
  reference system other than `EPSG:3857` or `EPSG:4326`, an empty coverage rectangle) leaves its whole layer out:
  `createGlobe` logs an error and emits `error`, and `imageryLayers.add` throws.
- PMTiles and MBTiles raster sources are read as Web Mercator tiles of 256 pixels.
- Tiles from another origin need `Access-Control-Allow-Origin` on the tile server. Without it the engine logs one error
  naming the source and the cause, and treats its tiles as unavailable instead of retrying them.
- `mbtilesImagery` downloads the whole package before it resolves (time limit 120 s, `downloadTimeoutMs`): serve
  large datasets as PMTiles.
- Source ids are unique per engine instance: they key the caches, the credits and the per-source switches.

## Errors

The asynchronous factories reject with a `SourceConfigError`: a stable `code` and a message naming the source.

| Code                                                          | When                                                                                                       | What to do                                    |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `invalid-url-template`                                        | `xyzImagery`: unknown field, unpaired brace, no `{z}`/`{x}`/`{y}`                                          | fix the template                              |
| `invalid-option`                                              | `xyzImagery` `blankTile` not `#rrggbb`, `blankShare` not in (0, 1]; `mercatorImage` `maxLevel` out of 0–22 | fix the option                                |
| `unreachable-capabilities`, `invalid-capabilities`            | WMS or WMTS capabilities cannot be loaded or parsed                                                        | check the URL, CORS and the document          |
| `unknown-layer`, `no-layers`                                  | the layer is not in the capabilities, or none is named                                                     | use an identifier from the capabilities       |
| `no-resource-url`, `no-kvp-endpoint`, `no-getmap-url`         | the service lacks the endpoint the request needs                                                           | pick the other `encoding`, or pass `url`      |
| `needs-reprojection`                                          | the service or image uses another reference system                                                         | pass `transforms`                             |
| `unreadable-archive`, `not-raster`, `invalid-levels`          | PMTiles: unreadable, not raster tiles, or minimum zoom above maximum                                       | check the archive and its range requests      |
| `unreachable-package`, `unreadable-package`                   | MBTiles: download failed, or not an MBTiles file                                                           | check the URL and `wasmUrl`                   |
| `invalid-bounds`, `invalid-world-file`, `rotated-image`       | single image: bad bounds, bad world file, or a rotated world file                                          | fix the placement; rotation is not supported  |
| `missing-georeference`                                        | single image without `bounds` or a world file of six numbers                                               | pass one of them                              |
| `unreachable-image`, `unreadable-image`, `unreadable-geotiff` | the image cannot be downloaded or decoded                                                                  | check the URL, CORS and the format            |
| `missing-app-identity`, `osm-subdomains`                      | OpenStreetMap public servers without `appName`/`appUrl`, or with `{s}`                                     | identify the application; use the single host |
| `unreachable-layer`, `invalid-layer`                          | quantized-mesh terrain: `layer.json` cannot be loaded, or is not a valid one                               | check the URL, CORS and the file              |

The engine reports a display-only source's refused data access as a `GlobeError` with code `display-only`.

## See also

- [Offline packages](offline.md): persistent cache, network modes, loading switches and packages.
- [Terrain](terrain.md): datums, elevation queries and the camera above the ground.
- [Hosting](hosting.md): serving tiles, packages and engine assets.
- [Vector tiles](vector-tiles.md): styled vector maps.
- [Data licenses](../data-licenses.md): the terms of the default datasets.
