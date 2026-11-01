---
title: Hosting tiles, packages and engine assets
---

# Hosting tiles, packages and engine assets

VibeGlobe runs no servers: every application hosts its own tiles, offline packages, global base image and worker
program, on its own origins. This guide lists what to serve, the HTTP headers the engine needs, and three setups: a
static HTTP server, object storage behind a CDN, and a LAN server for offline sites. The adapters that read the files
are in the [sources guide](sources.md), packages in the [offline guide](offline.md), and bundler details in the
[integration guide](integration.md#hosting-the-engines-assets).

## Quick start

```ts
import { createGlobe } from '@vibeglobe/core';
import { xyzImagery } from '@vibeglobe/sources';
import { createWorkers } from '@vibeglobe/worker';

const assets = '/static/vibeglobe/'; // your base path
createGlobe({
  container,
  renderer,
  baseImageryUrl: `${assets}fallback-base.jpg`,
  workers: createWorkers({ url: `${assets}vibeglobe-worker.js` }),
  imagery: [xyzImagery({ id: 'imagery', url: 'https://tiles.example.com/imagery/{z}/{x}/{y}.jpg', maxLevel: 14 })],
});
```

The page loads the worker program and the base image from its own origin and the tiles from the tile host.

## What to host

| What                  | Produced by                                                                  | Files                                                         |
| --------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Static tile folders   | `vibeglobe-data build <config>` (`output/<dataset>/`)                        | `{z}/{x}/{y}.<ext>` and `metadata.json`                       |
| PMTiles packages      | `vibeglobe-data build` (`output/<dataset>.pmtiles`), `vibeglobe-data pack`   | one file per dataset or area, read with range requests        |
| MBTiles packages      | `outputs.mbtiles: true` in a dataset, `vibeglobe-data pack --format mbtiles` | one SQLite file, downloaded whole by `mbtilesImagery`         |
| The global base image | `vibeglobe-data build world-low.json --dataset fallback`                     | `output/fallback-base.jpg`, for `GlobeOptions.baseImageryUrl` |
| Engine assets         | `@vibeglobe/worker` through your bundler                                     | the worker program, its WebAssembly and chunks                |

- Tile extensions follow the dataset: `.png` for Terrarium terrain and PNG imagery, `.jpg` for JPEG imagery, `.pbf`
  for vector tiles, `.webp` for WebP extracts.
- `output/` is under the folder `--out` names.
- Empty vector tiles are not written: a `404` for a `.pbf` inside a dataset's zoom range means "no features here".
  Imagery and terrain folders hold every tile of their area.

## Engine assets on your own origin

- `createWorkers()` without `url` starts the worker program your bundler emitted from `@vibeglobe/worker` (Vite,
  webpack 5 and Parcel find it). It is served with your build; there is nothing else to copy.
- `createWorkers({ url })` starts a program you host. The URL must be same-origin and neither `blob:` nor `data:`,
  else `createWorkers` throws a `WorkerConfigError` (`cross-origin-url`, `unsupported-url`). The program must be one
  self-contained module, such as the `vibeglobe-worker-<hash>.js` your bundler emits. The files in
  `node_modules/@vibeglobe/worker/dist/` import other packages by name and cannot be served as they are.
- The worker program loads its WebAssembly (`vibeglobe-basis-<hash>.wasm`, `meshopt-decoder-<hash>.wasm`) from its own
  directory. Vite's default `base: '/'` writes those URLs as `/assets/…`; build with `base: './'` to serve the emitted
  `assets/` folder under another path, as the
  [minimal-globe example](https://github.com/SimoneRecchia/VibeGlobe/blob/main/examples/minimal-globe/vite.config.ts)
  does.
- An application with only imagery and terrain imports `createWorkers` from `@vibeglobe/worker/basic`, whose program
  (`vibeglobe-worker-basic-<hash>.js`) needs neither `@vibeglobe/layers` nor `@vibeglobe/models`.

## HTTP requirements

| Requirement    | Value                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------------- |
| MIME types     | the table below                                                                                                  |
| CORS           | tiles and packages on another origin: `Access-Control-Allow-Origin: <your app's origin>` (or `*`)                |
| CORS, PMTiles  | also `Access-Control-Allow-Headers: Range`, `Access-Control-Expose-Headers: Content-Length, Content-Range, ETag` |
| Range requests | PMTiles needs `Accept-Ranges: bytes` and `206 Partial Content` answers                                           |
| Caching        | `Cache-Control: public, max-age=31536000, immutable` when the URL carries a version; else `max-age` with `ETag`  |
| Compression    | `gzip` or `br` for `.pbf` and `.json`; never for PNG, JPEG, WebP or PMTiles                                      |

| Extension  | `Content-Type`                                                             |
| ---------- | -------------------------------------------------------------------------- |
| `.png`     | `image/png`                                                                |
| `.jpg`     | `image/jpeg`                                                               |
| `.webp`    | `image/webp`                                                               |
| `.pbf`     | `application/x-protobuf` (or `application/vnd.mapbox-vector-tile`)         |
| `.pmtiles` | `application/octet-stream`                                                 |
| `.mbtiles` | `application/octet-stream`                                                 |
| `.json`    | `application/json`                                                         |
| `.js`      | `text/javascript`                                                          |
| `.wasm`    | `application/wasm` (compiled while it downloads; other types work, slower) |

Check that a CDN neither strips `Range` nor caches a range as the whole file.

## Attribution

Every output's `metadata.json`, and the PMTiles and MBTiles metadata, carry the `attribution` its license requires
([data licenses](../data-licenses.md)). Show it wherever the data is displayed, for example in the source's
`attribution`:

```ts
const { attribution } = await (await fetch('https://tiles.example.com/imagery/metadata.json')).json();
```

`pmtilesImagery` and `mbtilesImagery` read the archive's attribution themselves. The Copernicus DEM licence also
states that the Copernicus organisations incur no liability for any use of the data; OpenStreetMap-derived tiles are a
Produced Work under the ODbL.

## Setup 1: a plain static HTTP server (nginx)

Lay out one folder:

```text
site/
  index.html, assets/…          your application's build (worker program and WebAssembly included)
  static/vibeglobe/             fallback-base.jpg, and vibeglobe-worker.js when you host it by hand
  tiles/<config>-<version>/     the pipeline's output/ folder: imagery/, terrain/, vectors/, *.pmtiles
```

and serve it with this `nginx.conf` (any static server with the same headers works):

```text
events {}
http {
  include mime.types;
  types { application/x-protobuf pbf; application/octet-stream pmtiles; }
  server {
    listen 8080;
    root /usr/share/nginx/html;
    location /tiles/ {
      add_header Access-Control-Allow-Origin * always;
      add_header Access-Control-Allow-Headers Range always;
      add_header Access-Control-Expose-Headers "Content-Length, Content-Range, ETag" always;
      add_header Cache-Control "public, max-age=31536000, immutable" always;
      gzip on;
      gzip_types application/x-protobuf application/json;
    }
  }
}
```

```sh
docker run --rm -p 8080:8080 -v "$PWD/site:/usr/share/nginx/html:ro" -v "$PWD/nginx.conf:/etc/nginx/nginx.conf:ro" nginx:1.27-alpine
```

nginx answers range requests on static files by itself.

## Setup 2: object storage behind a CDN

Upload the `output/` folders and packages to a bucket (S3, Google Cloud Storage, Azure Blob, R2…) and put a CDN in
front:

- Set each object's `Content-Type` from the table above; set `.pbf` and `.pmtiles` explicitly.
- Add a CORS rule allowing `GET` and `HEAD` from your application's origin, with the `Range` request header and the
  exposed headers above.
- Upload vector tiles pre-compressed with `Content-Encoding: gzip`, or let the CDN compress them.
- Make the CDN forward `Range` to the origin and cache by range.
- Version the path (`/tiles/italy-high-1.0.0/`) so tiles can be cached as immutable.

## Setup 3: a LAN server for offline mode

For sites without internet access, copy `site/` to a machine on the LAN and run the nginx container above there;
PMTiles packages copy faster than millions of small files. Clients load the application, the engine assets and the
tiles from that machine only. The [offline guide](offline.md#offline-setup-1-a-server-on-the-local-network) shows the
repository's LAN server and how to read packages in place.

## Rules and pitfalls

- MBTiles is not read with range requests: `mbtilesImagery` downloads the whole file before the source resolves (time
  limit 120 s). Serve PMTiles on the web and keep MBTiles for devices and LANs.
- The worker program and its WebAssembly must come from the page's origin; tiles and packages may come from any origin
  that sends the CORS headers above.

## Checking a deployment

- `curl -I https://tiles.example.com/imagery/10/531/364.jpg` shows `200`, the right `Content-Type`,
  `Access-Control-Allow-Origin` and `Cache-Control`.
- `curl -I -H 'Range: bytes=0-126' https://tiles.example.com/imagery.pmtiles` answers `206` with `Content-Range`.
- The browser's network panel shows requests only to your own origins: the default configuration references no
  third-party service.

## See also

- [Integrating VibeGlobe](integration.md): bundlers, workers and the Content Security Policy.
- [Sources and adapters](sources.md): the adapters that read these files.
- [Offline packages](offline.md): installing and reading packages.
- [Data licenses](../data-licenses.md): the attribution of the default datasets.
