# 0032. OpenStreetMap tile usage policy and the OpenStreetMap public-servers profile

- Status: Accepted
- Date: 2026-10-22
- Milestone: M7 (source adapters track)

## Context

`PLAN.md` requires a profile for the OpenStreetMap Foundation's public tile servers: light use only, no offline packaging or bulk prefetch, low request concurrency, the application identified as the usage policy requires, attribution to OpenStreetMap contributors, documented as unsuitable for production (F263–F267). Self-hosted OpenStreetMap tiles built by the data pipeline use the self-hosted profile instead (everything enabled, ODbL attribution). Survey: [source-adapters.md](../research/source-adapters.md).

## Reading of the policy (2026-10-22)

The container's network policy blocks `operations.osmfoundation.org`, so the [Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/) and the [Vector Tile Usage Policy](https://operations.osmfoundation.org/policies/vector/) were read through web-search excerpts on 2026-10-22; the owner re-reads them from an unrestricted network (`docs/open-questions.md`, question 24). Rules found:

- Clearly display licence attribution (the [attribution guidelines](https://osmfoundation.org/wiki/Licence/Attribution_Guidelines): "© OpenStreetMap contributors" linked to <https://www.openstreetmap.org/copyright>), for vector tiles normally in the bottom-right corner.
- Identify the application: from web pages, send a valid HTTP `Referer` and do not set a restrictive `Referrer-Policy` that strips it; other clients send a valid `User-Agent` that identifies the application, never a library default or a faked one.
- Do not send no-cache headers (`Cache-Control: no-cache`, `Pragma: no-cache`); cache tiles locally according to the HTTP caching headers (at least 7 days when the headers cannot be read).
- No bulk downloading ("scraping") and no prefetch features; no offline use; heavy use is throttled, served a placeholder or blocked without notice; no service-level guarantee.
- The servers have limited, donated capacity; the policy points heavy users to self-hosting or commercial providers. The technical-requirements section asks applications to keep the number of connections low (OSMF operations have long asked for at most two connections).

## Decision: rule → profile setting

| Rule                                               | Setting of `OSM_PUBLIC_PROFILE` and `openStreetMapImagery` / `openStreetMapVectorTiles`                                                                                                                                                                                                                                             |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No bulk download, no prefetch                      | `forbids`: `prefetch`                                                                                                                                                                                                                                                                                                               |
| No offline use                                     | `forbids`: `offlinePackaging`, `persistentCache`                                                                                                                                                                                                                                                                                    |
| Low connection count                               | `maxConcurrentRequests: 2`, and the source's `maxRequestsPerHost: 2` (one host, `tile.openstreetmap.org`)                                                                                                                                                                                                                           |
| Identify the application                           | `appName` and `appUrl` are required (configuration error without them); requests go with `referrerPolicy: 'strict-origin-when-cross-origin'` so the browser always sends the page's origin as `Referer`; outside browsers the transport sends a `User-Agent` built from them (no custom header, which would force a CORS preflight) |
| No no-cache request headers; honor caching headers | `cache: 'default'` (the browser's HTTP cache, which follows the server's headers); no `Cache-Control` or `Pragma` request header; `respectCacheHeaders: true`                                                                                                                                                                       |
| Attribution                                        | `requiredAttribution`: `© OpenStreetMap contributors` linked to `https://www.openstreetmap.org/copyright`                                                                                                                                                                                                                           |
| Light use only, unsuitable for production          | Creating a source of the profile warns once in the console (one per engine instance that uses it); the sources guide says so and points to the self-hosted profile                                                                                                                                                                  |

## Consequences

- The profile is for demos and development; products use the pipeline's self-hosted tiles (ADR 0024).
- The concurrency limit is enforced by the engine's per-host request slots (F089), which honor `maxRequestsPerHost`.
- `User-Agent` cannot be set from browsers; in Node the adapter's transport sets it from `appName` and `appUrl`.

## Amendment 2026-10-24: the owner's reading

The owner read the tile and vector tile usage policies from an unrestricted network on 2026-10-24 (open question 24). They confirm the rules above, and add:

| Rule                                                                                                                                                             | Setting                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raster tiles only from exactly `https://tile.openstreetmap.org/{z}/{x}/{y}.png`, no subdomains                                                                   | `openStreetMapImagery` refuses a `{s}` URL or the retired `a`/`b`/`c` hosts with the configuration error `osm-subdomains`; the default URL is the one named |
| Attribution never hidden behind toggles or other UI                                                                                                              | `requiredAttribution` is a required credit: the engine's credits and the UI's attribution control keep required credits visible when collapsed (F424, F259) |
| Honor `Cache-Control`, `Expires` and `ETag`, with conditional requests                                                                                           | Unchanged: `cache: 'default'` (the browser's HTTP cache sends `If-None-Match` and `If-Modified-Since`) and `respectCacheHeaders: true`                      |
| A "Report a map issue" link to <https://www.openstreetmap.org/fixthemap> is recommended                                                                          | The public raster source's attribution adds it, after the required credit                                                                                   |
| Vector tiles from `https://vector.openstreetmap.org/$VERSION/{z}/{x}/{y}.mvt` or its TileJSON (Shortbread schema; old versions retired after about three months) | Applications pass that URL, with a current `$VERSION`, to the vector tile source; no default ships, so a retired version never stays in the code            |
| Keep 2 connections and no prefetch                                                                                                                               | Unchanged: `maxConcurrentRequests: 2`, `forbids: prefetch`                                                                                                  |
