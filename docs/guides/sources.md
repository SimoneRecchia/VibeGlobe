---
title: Sources and adapters
---

# Sources and adapters

Every map layer reads its data through a source adapter of `@vibeglobe/sources`. Adapters implement the engine's source contract (`ImagerySource` in `@vibeglobe/core`): a tiling scheme, levels, coverage, a `request(coord)` that addresses a tile, and a transport that fetches it. They also declare their attribution and their provider profile. This guide covers the adapter interface, every built-in adapter, reprojection, layer composition and source chains, provider profiles, and writing and testing your own adapter with the conformance suites. Every example below runs as a test (`scripts/integration/sources-guide.test.ts`).

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
  transport: fetchTransport(), // fetches the bytes; a source may bring its own
  request(coord, out) {
    // Write the tile's URL and host, or answer 'noData' for a tile that never exists.
    if (coord.level > 16) return 'noData';
    out.url = `https://tiles.example.com/${coord.level}/${coord.x}/${coord.y}.png`;
    out.hostIndex = 0;
    return out;
  },
};
// Credits and provider rules: `withProfile` adds them and caps per-host concurrency at the profile's limit.
const mine = withProfile(plain, CUSTOM_PROFILE, [{ text: '© My tiles', url: 'https://tiles.example.com/' }]);
```

A terrain source (`TerrainSource`) adds a decoder (`terrarium`, `terrain-rgb`, `quantized-mesh`, or a custom `decode` function), its vertical datum and its geometric error per level. The engine validates every source when it is added: a source with inverted levels, a zero tile size or an unknown reference system is refused with a message naming it, and the other layers keep rendering.

## Imagery adapters

```ts
import { createGlobe } from '@vibeglobe/core';
import { pmtilesImagery, wmsImagery, wmtsImagery, xyzImagery } from '@vibeglobe/sources';
import { mbtilesImagery } from '@vibeglobe/sources/mbtiles';

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

const globe = createGlobe({ container, renderer, baseImageryUrl, workers, imagery: [xyz, wmts, archive] });
```

| Adapter          | Reads                                                                             | Notes                                                                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `xyzImagery`     | XYZ and TMS URL templates (`{z}`, `{x}`, `{y}`, `{-y}`, `{s}`)                    | Subdomains, `@2x` tiles, coverage, per-host concurrency                                                                                                              |
| `wmtsImagery`    | WMTS 1.0.0 GetCapabilities (URL or XML text)                                      | Layers, styles, formats, dimensions (`dimensions: { Time: '2024' }`), tile matrix limits; RESTful or KVP; EPSG:3857 or EPSG:4326 requested directly (`preferredCrs`) |
| `wmsImagery`     | WMS 1.1.1 and 1.3.0 GetMap, one image per tile                                    | 1.3.0's latitude-first EPSG:4326, transparency, a 32 px gutter cropped away so labels are never cut (`gutterPx`), XML service exceptions treated as failures         |
| `pmtilesImagery` | PMTiles v3 raster archives over HTTP range requests, or a local `File` or `Blob`  | The header and directories are read once and cached; levels, bounds and attribution come from the archive                                                            |
| `mbtilesImagery` | MBTiles packages (plain or deduplicated schema) from a local file or a LAN server | In `@vibeglobe/sources/mbtiles` (it brings SQLite as WebAssembly); host `sql-wasm.wasm` from the `sql.js` package next to your other engine assets and pass its URL  |

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
// Packages of terrain tiles (F328): the same encodings in a PMTiles archive or an MBTiles package.
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

`createGlobe({ terrain })` takes one terrain source. Heights are meters above the WGS84 ellipsoid unless the source declares a geoid `datum` (see the terrain guide).

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

`pmtilesVector` and `mbtilesVector` read Mapbox Vector Tiles from packages over HTTP, from a local file or, wrapped by `@vibeglobe/offline`, from browser storage.

The asynchronous factories read capabilities, archive headers or sessions before they return, and reject with a `SourceConfigError` (a stable `code` and a message naming the source) when the service cannot be used. Services that offer only other reference systems are reprojected on the client when you pass `transforms` (next section); without them they are refused with the code `needs-reprojection`.

## Single georeferenced images

```ts
import { singleImage } from '@vibeglobe/sources';
import { geotiffImage } from '@vibeglobe/sources/geotiff';

// A PNG, JPEG or WebP placed by its bounds (west, south, east, north in the units of `crs`, degrees by default)…
const flood = await singleImage({
  id: 'flood-map',
  image: 'https://images.example.com/flood.png',
  bounds: [12.3, 41.7, 12.7, 42.0],
  attribution: [{ text: '© Civil protection' }],
});
// …or by its world file, or a GeoTIFF by its own tags; other systems are reprojected through `transforms`.
const scan = await singleImage({
  id: 'scan',
  image: 'https://images.example.com/scan.jpg',
  crs: 'EPSG:3857',
  worldFile: '10\n0\n0\n-10\n1380000.5\n5150000.5\n',
});
const survey = await geotiffImage({ id: 'survey', image: 'https://images.example.com/survey.tif' });
```

The image is downloaded and decoded once, and every engine tile draws its own piece, so an image larger than the GPU's texture limit shows completely. Rotated world files are refused with a `SourceConfigError`, as are images that cannot be read or placed.

A Web Mercator image of the whole world (180° W to 180° E, about 85.05° S to 85.05° N), such as night lights shown
from afar, needs no reprojection: `mercatorImage` downloads it with the first tile, decodes it once and cuts each tile
of levels 0 to `maxLevel` from it on request; the engine enlarges the finest tiles beyond. A failed download is tried
again with the next tile, and tiles fail as downloaded ones do. For an image of part of the world, use `singleImage`
with `crs: 'EPSG:3857'` and its bounds.

```ts
import { mercatorImage } from '@vibeglobe/sources';

// 2048 pixels wide: levels 0 to 3 are cut from it at their full resolution.
const lights = mercatorImage({
  id: 'night-lights',
  image: 'https://images.example.com/night-lights.webp',
  maxLevel: 3,
  attribution: [{ text: 'Night lights: NASA Black Marble' }],
});
// A layer of its own: globe.imageryLayers.add({ id: 'night-lights', blend: 'night', sources: [lights] }).
```

## Reprojection

The engine draws Web Mercator and geographic tile pyramids. A service in another reference system, such as Italian data in UTM zones 32N and 33N (EPSG:32632, EPSG:32633) or a custom WMTS tile matrix set, is reprojected on the client ([ADR 0039](../adr/0039-reprojection-and-tone-harmonization.md)): each engine tile asks for the source image covering it (a WMS GetMap, or the WMTS tiles composed in place) and warps it piecewise-affinely.

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
// A WMTS layer whose only tile matrix set is in UTM 32N: reprojected because `transforms` knows its system.
const utmWmts = await wmtsImagery({
  id: 'utm',
  capabilities: 'https://wmts.example.com/WMTSCapabilities.xml',
  layer: 'utm-only',
  transforms,
});
// Any image service in its own system: the bounds are in its units, `image` names the picture of a box.
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

`wmsImagery` takes the same `transforms`. Reprojected tiles are transparent outside the data, so the layers below show there.

## Polar caps

Web Mercator sources end at ±85.0511°. Beyond, the globe draws two polar caps in geographic tiles: a geographic (EPSG:4326) imagery source that covers them, such as NASA GIBS in `EPSG:4326`, fills them; otherwise each cap shows one fill color, the sea of the default base image in the north and its ice in the south. Choose the colors at start or change them at runtime:

```ts
import { createGlobe } from '@vibeglobe/core';

const globe = createGlobe({ container, renderer, baseImageryUrl, polarCapColors: { north: '#0b2a4a' } });
globe.setPolarCapColors({ north: '#1d3d5f', south: '#ffffff' });
```

A view that reaches a cap stays a globe at every zoom (ADR 0008, update of 2026-10-26), so the cap is always a whole disc.

## Layer composition and source chains

`createGlobe({ imagery })` takes layers bottom first. A layer is a source, or a chain of sources in priority order with its look: each tile comes from the first source that has it, and a source that fails (errors, timeouts, offline) leaves its tiles to the next one ([ADR 0038](../adr/0038-imagery-layer-stack.md)).

```ts
import { createGlobe } from '@vibeglobe/core';
import { xyzImagery } from '@vibeglobe/sources';

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
globe.imageryLayers.move('labels', 0); // reorder at runtime
```

Blend modes are `normal`, `multiply`, `screen` and `night`: a `night` layer is light added on the night side of the
atmosphere's day and night (F647, the [space background guide](space-background.md#day-and-night-and-a-clearer-globe-from-afar)
shows it with a city-lights image). Blended and translucent layers share the two overlay slots of each surface tile.

A source limited to a country or a region gets its `area`: rectangles (`coverage`), polygons, or GeoJSON such as a
country's borders. Tiles wholly outside the area are never requested. With GeoJSON (or `tiles: 'clip'`), tiles that
cross the border are requested too, and their pixels outside the area become transparent when they are decoded, so the
layer below shows there instead of the white or black filler many national services send beyond their country
(F618, KB-209). Put such a source in its own layer above the fallback: a layer's chain draws each tile from one source.
`@vibeglobe/presets/countries` has the borders of Europe's countries (`await countryBorders('AT')`, Natural Earth,
public domain). `blankTile` is the fallback for services whose area is not known: their tiles of that color alone count
as no data.

```ts
import { createGlobe } from '@vibeglobe/core';
import { xyzImagery } from '@vibeglobe/sources';

const world = xyzImagery({ id: 'world', url: 'https://world.example.com/{z}/{x}/{y}.jpg', maxLevel: 9 });
const national = xyzImagery({
  id: 'national-ortho',
  url: 'https://ortho.example.com/{z}/{x}/{y}.jpg',
  maxLevel: 19,
  // The country's borders as GeoJSON: border tiles are clipped per pixel.
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

The vector parsers run in workers: `@vibeglobe/sources/vector` exports them and `VECTOR_TASKS`, the worker task table the engine's worker program registers.

```ts
import { decodeMvt, parseGeoJson, parseGpx, parseKml } from '@vibeglobe/sources/vector';

const { features, issues } = parseGeoJson(text); // every geometry type; invalid features are listed in `issues`
const kml = parseKml(kmzBytes); // placemarks with styles and folders, ground overlays, the archive's images in `resources`
const gpx = parseGpx(text); // waypoints, routes and tracks with elevation and time
const tile = decodeMvt(bytes); // layers and features in tile coordinates, or undefined for a malformed tile
```

No parser throws: a malformed document gives an empty result with its issue, and a malformed tile is no data.

## Provider profiles

A provider profile switches off what a provider's terms forbid; it never switches anything on. Every loading feature (persistent cache, memory reuse, prefetch and flight preloading, offline packaging) is on by default; a profile switches off only what its provider forbids, and only for its own source; you can switch off more, globally or per source, with `@vibeglobe/offline`, but nothing switches on what a profile forbids (a warning names the rule).

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
// Two sets of terms at once (a provider serving someone else's data): every rule of both applies.
const strictest = combineProfiles(acme, { id: 'reseller', forbids: new Set(['prefetch']), respectCacheHeaders: true });
```

The engine and `@vibeglobe/offline` enforce a declared profile exactly as they enforce the built-in ones, and the conformance suite checks it.

### Google Maps Platform

```ts
import { googleImagery, googleStreetView } from '@vibeglobe/sources';

const google = await googleImagery({
  id: 'google',
  apiKey: myRestrictedKey, // the customer's own key, restricted to their sites
  billingRegion: 'eea', // or 'other': the terms differ, and there is no default
  mapType: 'roadmap', // EEA accounts get roadmap and terrain only
  language: 'it-IT',
  region: 'IT',
  logoUrl: '/assets/google-logo.png',
});
const copyright = await google.viewportCopyright({
  zoom: 12,
  westDeg: 12.3,
  southDeg: 41.8,
  eastDeg: 12.6,
  northDeg: 42,
});
```

The adapter creates and renews Map Tiles API sessions itself. `followGoogleCopyrights(globe, google)` keeps the credits on the copyrights Google returns for each settled view: one viewport request per settled view, never per frame, shown after the logo through `globe.refreshCredits()`. The Google profile forbids the persistent cache, prefetch and offline packaging, reuses tiles in memory only while Google's cache headers allow it, and requires Google's logo and the viewport's copyrights to stay visible ([ADR 0031](../adr/0031-google-maps-platform-terms.md)). `googleStreetView` reads Street View metadata and panorama tiles under the same profile. The logo and its text say "Google Maps", 16 px high with 10 px of clear space (5 px below).

Billing accounts in the European Economic Area get neither 2D satellite tiles, Street View nor Photorealistic 3D Tiles ([Map Tiles API EEA guide](https://developers.google.com/maps/comms/eea/map-tiles)): with `billingRegion: 'eea'`, `mapType: 'satellite'`, the `layerStreetview` layer, `googleStreetView` and `google3dTiles` throw a `SourceConfigError` (`not-available-in-eea`) that names those terms.

### OpenStreetMap public servers

```ts
import { openStreetMapImagery } from '@vibeglobe/sources';

const osm = openStreetMapImagery({ appName: 'My demo', appUrl: 'https://demo.example.com/' });
```

**The OpenStreetMap Foundation's public tile servers are unsuitable for production products.** They run on donated capacity for light use only; the profile keeps at most two requests in flight, identifies the application on every request, forbids prefetch and offline packaging, and logs one warning when it is used ([ADR 0032](../adr/0032-openstreetmap-tile-usage-policy.md)). Products serve tiles built from an OpenStreetMap extract by the data pipeline (`vibeglobe-data`, see the hosting guide), with the attribution "© OpenStreetMap contributors" and no usage limits beyond their own servers'.

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

Self-hosted OpenStreetMap tiles enable every feature and show "© OpenStreetMap contributors, ODbL" linked to the copyright page; a commercial provider's profile adds its own rules and credit on top.

### Apple map data

Apple's map data may only be used through Apple's own MapKit, so VibeGlobe offers no Apple adapter.

## Keeping secrets out of URLs

Send credentials in headers where the provider supports it (`headers` on the PMTiles and MBTiles adapters). Where a provider requires a key in the URL, as Google's Map Tiles API does, the adapter adds the key and the session inside its own transport: the URLs the engine sees, coalesces, logs and shows in the debug overlay carry neither.

Any tiled adapter that takes a `transport` gets the same protection from `fetchTransport`'s third argument:

```ts
import { fetchTransport, xyzImagery } from '@vibeglobe/sources';

const transport = fetchTransport(undefined, undefined, {
  // Headers sent only to these origins; renewed once when the server answers 401 or 403.
  auth: {
    origins: ['https://tiles.example.com'],
    headers: () => ({ Authorization: `Bearer ${session.token}` }),
    refresh: () => session.renew(),
  },
  // A key the provider insists on in the URL: appended only when the request is made.
  secretQuery: () => ({ key: myRestrictedKey }),
  // The fetch credentials mode (cookies) for this source; 'omit' by default.
  credentials: 'omit',
});
const imagery = xyzImagery({ id: 'tiles', url: 'https://tiles.example.com/{z}/{x}/{y}.png', transport });
```

The engine never sees the `secretQuery` values or the headers, so its logs, traces, errors and debug overlay cannot show them. When your own code logs URLs, pass them through `redactUrl`, which masks the values of query parameters named like keys, tokens and signatures. Tiles from another origin need CORS headers (`Access-Control-Allow-Origin`) on the tile server; without them the engine logs one error naming the source and the cause, and treats its tiles as unavailable instead of retrying them.

## Writing and testing a custom adapter

An adapter is any object that implements `ImagerySource`; add `attribution` and `profile` (`DescribedImagerySource`) so the engine can credit it and enforce its terms. Run the shared conformance suite, which needs no test framework, from your own tests:

```ts
import { failures, runTiledConformance } from '@vibeglobe/sources/conformance';

const results = await runTiledConformance({
  name: 'my adapter',
  create: (fetchImpl) => myAdapter({ fetch: fetchImpl }),
  fixture: myRecordedService, // a fetch that answers like the real service
  tiles: [{ coord: { root: 0, level: 3, x: 4, y: 2 } }],
  missing: [{ root: 0, level: 3, x: 5, y: 2 }],
});
expect(failures(results)).toEqual([]);
```

It checks metadata, tile addressing, coverage, the zoom range, 404 and 500 answers, timeouts, corrupted payloads, cancellation, attribution and the profile's rules (concurrency, required credit and logo, and any `profileChecks` you add). Terrain adapters run the same checks plus decoded heights at reference points:

````ts
import { heightmapTerrain } from '@vibeglobe/sources';
import { failures, runTerrainConformance } from '@vibeglobe/sources/conformance';

const terrainResults = await runTerrainConformance({
  name: 'my terrain',
  create: (fetchImpl) =>
    heightmapTerrain({
      id: 'dem',
      url: 'https://dem.example.com/{z}/{x}/{y}.png',
      encoding: 'terrarium',
      transport: myTransport(fetchImpl),
    }),
  fixture: myRecordedService,
  tiles: [{ coord: { root: 0, level: 3, x: 4, y: 2 } }],
  heights: [{ coord: { root: 0, level: 3, x: 4, y: 2 }, u: 0.5, v: 0.5, meters: 120, toleranceMeters: 0.5 }],
  decodeImage: myPngDecoder, // RGBA of a heightmap tile; the browser decodes images in the engine
});
expect(failures(terrainResults)).toEqual([]);
``` `runParserConformance` checks a parser against fixtures and fuzzes it. The opt-in live run (`npm run test:live-sources`, or the manual "Live sources" workflow in CI) contacts only endpoints whose terms allow automated tests, Google only with `GOOGLE_MAPS_API_KEY` set, and stops at the first quota error.
````
