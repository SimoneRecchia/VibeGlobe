---
title: Hosting tiles, packages and engine assets
---

# Hosting tiles, packages and engine assets

VibeGlobe runs no servers (ADR 0015): every application hosts its own tiles, offline packages and engine assets, on its own backend and frontend. This guide shows what to serve and how, with three setups: a plain static HTTP server, object storage behind a CDN, and a LAN server for offline mode. Nothing here depends on a server run by the project.

## What to host

| What                  | Produced by                                                                           | Files                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Static tile folders   | `vibeglobe-data build <config>` (`output/<dataset>/`)                                 | `{z}/{x}/{y}.png` (Terrarium terrain, PNG imagery), `{z}/{x}/{y}.jpg` (JPEG imagery), `{z}/{x}/{y}.pbf` (vector tiles), and `metadata.json` |
| PMTiles packages      | `vibeglobe-data build` (`output/<dataset>.pmtiles`), `vibeglobe-data pack`            | one file per dataset or area, read with HTTP range requests                                                                                 |
| MBTiles packages      | `vibeglobe-data build` with `"mbtiles": true`, `vibeglobe-data pack --format mbtiles` | one SQLite file: for import onto devices; browsers do not read it over HTTP                                                                 |
| The global base image | `vibeglobe-data build world-low.json --dataset fallback` (`output/fallback-base.jpg`) | the whole-world image the engine pins (`GlobeOptions.baseImageryUrl`)                                                                       |
| Engine assets         | the `@vibeglobe/worker` package (`vibeglobe-worker.js`) and your bundler's output     | the worker program and the application's own scripts                                                                                        |

Empty vector tiles are not written: a `404` for a `.pbf` inside a dataset's zoom range means "no features here". Imagery and terrain folders hold every tile of their area.

## Engine assets on your own origin

Workers must come from the page's own origin (ADR 0015, decision 11), so serve the engine's assets next to your application, under a base path you choose:

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

The worker program must be one self-contained module. Bundlers that resolve `new URL('@vibeglobe/worker/vibeglobe-worker.js', import.meta.url)` (Vite, webpack 5, Rollup) emit it into your build as `vibeglobe-worker-<hash>.js`: serve that file under your base path as `vibeglobe-worker.js`, or point `createWorkers({ url })` at the emitted name. The unbundled files in `node_modules/@vibeglobe/worker/dist/` import other packages by name and cannot be served as they are.

## HTTP requirements

| Requirement    | Value                                                                                                                                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MIME types     | `.png` `image/png`; `.jpg` `image/jpeg`; `.pbf` `application/x-protobuf` (or `application/vnd.mapbox-vector-tile`); `.pmtiles` `application/octet-stream`; `.json` `application/json`; `.js` `text/javascript`                                     |
| CORS           | Tiles and packages on another origin: `Access-Control-Allow-Origin: <your app's origin>` (or `*` for public data); for PMTiles also `Access-Control-Allow-Headers: Range` and `Access-Control-Expose-Headers: Content-Length, Content-Range, ETag` |
| Range requests | PMTiles needs `Accept-Ranges: bytes` and `206 Partial Content` answers. Most static servers and object stores support it; check a CDN does not strip `Range` or cache a range as the whole file                                                    |
| Caching        | Tiles from a pinned configuration never change: `Cache-Control: public, max-age=31536000, immutable` when the URL carries the configuration version (for example `/tiles/italy-high-1.0.0/…`); otherwise a shorter `max-age` with `ETag`           |
| Compression    | PNG, JPEG and PMTiles are already compressed: serve them as they are. Vector tiles (`.pbf`) and `metadata.json` compress well: enable `gzip` or `br` for them, never for range requests on PMTiles                                                 |

## Attribution

Every output's `metadata.json` (and the PMTiles and MBTiles metadata) carries the exact `attribution` its license requires (ADR 0025, `docs/data-licenses.md` in the repository). Show it wherever the data is displayed, for example in the map's credits:

```ts
const { attribution } = await (await fetch('https://tiles.example.com/imagery/metadata.json')).json();
```

The Copernicus DEM licence also states that the Copernicus organisations incur no liability for any use of the data; OpenStreetMap-derived tiles are a Produced Work under the ODbL.

## Setup 1: a plain static HTTP server (nginx)

Lay out one folder:

```text
site/
  index.html, assets/…          your application's build
  static/vibeglobe/             vibeglobe-worker.js (the bundled worker), fallback-base.jpg
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

Upload the `output/` folders and packages to a bucket (S3, Google Cloud Storage, Azure Blob, R2…) and put a CDN in front:

- Set each object's `Content-Type` from the table above (most upload tools infer it; set `.pbf` and `.pmtiles` explicitly).
- Add a CORS rule on the bucket allowing `GET` and `HEAD` from your application's origin, with the `Range` request header and the exposed headers above.
- Upload vector tiles pre-compressed with `Content-Encoding: gzip`, or let the CDN compress them.
- Make the CDN forward the `Range` header to the origin and cache by range (CloudFront, Cloudflare and Fastly do this for static objects).
- Version the path (`/tiles/italy-high-1.0.0/`) so tiles can be cached as immutable.

## Setup 3: a LAN server for offline mode

For sites without internet access, copy `site/` (with PMTiles packages rather than millions of small files, which copy faster) to a machine on the LAN and run the nginx container above there. Clients load the application, the engine assets and the tiles from that machine only.

## Checking a deployment

- `curl -I https://tiles.example.com/imagery/10/531/364.jpg` shows `200`, the right `Content-Type`, `Access-Control-Allow-Origin` and `Cache-Control`.
- `curl -I -H 'Range: bytes=0-126' https://tiles.example.com/imagery.pmtiles` answers `206` with `Content-Range`.
- The browser's network panel shows requests only to your own origins: the default configuration references no third-party service (F344).
