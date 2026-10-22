---
title: Sources and adapters
---

# Sources and adapters

Every map layer reads its data through a source adapter of `@vibeglobe/sources`. Adapters implement the engine's source contract (`ImagerySource` in `@vibeglobe/core`): a tiling scheme, levels, coverage, a `request(coord)` that addresses a tile, and a transport that fetches it. They also declare their attribution and their provider profile. This guide covers the built-in adapters, the provider profiles and the conformance suites; layer composition, reprojection and source chains are described with the engine's layer API.

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

The asynchronous factories read capabilities, archive headers or sessions before they return, and reject with a `SourceConfigError` (a stable `code` and a message naming the source) when the service cannot be used. Services that offer only other reference systems (for example UTM zones) are refused with the code `needs-reprojection` until the engine's reprojection takes them.

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

A provider profile switches off what a provider's terms forbid; it never switches anything on.

### Google Maps Platform

```ts
import { googleImagery, googleStreetView } from '@vibeglobe/sources';

const google = await googleImagery({
  id: 'google',
  apiKey: myRestrictedKey, // the customer's own key, restricted to their sites
  billingRegion: 'eea', // or 'other': the terms differ, and there is no default
  mapType: 'satellite',
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

The adapter creates and renews Map Tiles API sessions itself. The Google profile forbids the persistent cache, prefetch and offline packaging, reuses tiles in memory only while Google's cache headers allow it, and requires Google's logo and the viewport's copyrights to stay visible ([ADR 0031](../adr/0031-google-maps-platform-terms.md)). `googleStreetView` reads Street View metadata and panorama tiles under the same profile.

### OpenStreetMap public servers

```ts
import { openStreetMapImagery } from '@vibeglobe/sources';

const osm = openStreetMapImagery({ appName: 'My demo', appUrl: 'https://demo.example.com/' });
```

**The OpenStreetMap Foundation's public tile servers are unsuitable for production products.** They run on donated capacity for light use only; the profile keeps at most two requests in flight, identifies the application on every request, forbids prefetch and offline packaging, and logs one warning when it is used ([ADR 0032](../adr/0032-openstreetmap-tile-usage-policy.md)). Products serve tiles built from an OpenStreetMap extract by the data pipeline (`vibeglobe-data`, see the hosting guide), with the attribution "© OpenStreetMap contributors" and no usage limits beyond their own servers'.

### Apple map data

Apple's map data may only be used through Apple's own MapKit, so VibeGlobe offers no Apple adapter.

## Keeping secrets out of URLs

Send credentials in headers where the provider supports it (`headers` on the PMTiles and MBTiles adapters). Where a provider requires a key in the URL, as Google's Map Tiles API does, the adapter adds the key and the session inside its own transport: the URLs the engine sees, coalesces, logs and shows in the debug overlay carry neither.

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

It checks metadata, tile addressing, coverage, the zoom range, 404 and 500 answers, timeouts, corrupted payloads, cancellation, attribution and the profile's rules. `runParserConformance` checks a parser against fixtures and fuzzes it. The opt-in live run (`npm run test:live-sources`) contacts only endpoints whose terms allow automated tests, Google only with `GOOGLE_MAPS_API_KEY` set, and stops at the first quota error.
