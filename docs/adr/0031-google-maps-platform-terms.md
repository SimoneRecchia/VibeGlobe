# 0031. Google Maps Platform terms and the Google profile

- Status: Accepted
- Date: 2026-10-22
- Milestone: M7 (source adapters track)

## Context

`PLAN.md` requires an optional Google Maps Platform adapter (Map Tiles API: 2D tiles, Street View tiles; Photorealistic 3D Tiles in M13) that uses the customer's own key and session tokens and whose profile switches off what Google's terms forbid, applying the terms of the customer's billing region (Google has separate terms for the European Economic Area). F256 asks for a dated reading of the terms mapped to profile settings; F261 for the billing-region rules; F549 for live tests within the free caps. Survey: [source-adapters.md](../research/source-adapters.md).

## Reading of the terms (2026-10-22)

The container's network policy blocks `developers.google.com` and `cloud.google.com`, so the pages were read through web-search excerpts on 2026-10-22, and the request shapes from the open-source OpenLayers (`source/Google.js`) and CesiumJS (`Google2DImageryProvider.js`) adapters. The owner re-reads the pages from an unrestricted network (`docs/open-questions.md`, question 24) and, if they differ, a new ADR amends this one.

- [Map Tiles API policies](https://developers.google.com/maps/documentation/tile/policies): no pre-fetching, indexing, storing or caching of content except as the agreement allows; no offline use; tiles only for map visualization; honor the `Cache-Control` headers Google returns (`max-age`, `stale-while-revalidate`, `must-revalidate`, `private`) and ETags; the Google logo and the data attributions visible and unaltered, the logo separate from the renderer's logo; place IDs exempt from caching limits.
- [Session tokens](https://developers.google.com/maps/documentation/tile/session_tokens): `POST https://tile.googleapis.com/v1/createSession?key=…` with `mapType` (`roadmap`, `satellite`, `terrain`, `streetview`), `language`, `region` and optional `layerTypes`, `scale`, `highDpi`, `imageFormat`; the answer carries `session`, `expiry` (seconds since the epoch, about two weeks for 2D), `tileWidth`, `tileHeight`, `imageFormat`. Tiles: `GET /v1/2dtiles/{z}/{x}/{y}?session=…&key=…`; viewport copyrights: `GET /tile/v1/viewport?session=…&key=…&zoom=…&north=…&south=…&east=…&west=…` answering `copyright`; Street View: `GET /v1/streetview/metadata?session=…&key=…&panoId=…` (or `lat`, `lng`, `radius`) and `GET /v1/streetview/tiles/{z}/{x}/{y}?session=…&key=…&panoId=…`.
- [Google Maps Platform Terms of Service](https://cloud.google.com/maps-platform/terms) and [Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms) for customers without an EEA billing address; [EEA Terms of Service](https://cloud.google.com/terms/maps-platform/eea) and [EEA Service Specific Terms](https://cloud.google.com/archive/terms/maps-platform/eea/maps-service-terms-20251118) for customers whose billing account address is in the EEA (effective 8 July 2025, [EEA FAQ](https://developers.google.com/maps/comms/eea/faq)). The EEA Service Specific Terms also allow caching Google IDs, including Street View `pano_ID`. The FAQ lists the Map Tiles API among services that behave differently in the EEA; a developer report says new EEA projects lose 2D satellite and Photorealistic 3D tiles (403), which Google's pages did not confirm.
- Free monthly usage (pricing categories, March 2025 onward): 100,000 billable events per month each for 2D Map Tiles and Street View Tiles (Essentials); no flat monthly credit.

## Decision: rule → profile setting

| Rule                                                                | Setting of `googleProfile(billingRegion)` and the adapters                                                                                                                 |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No storing or caching beyond what the terms allow; no offline use   | `forbids`: `persistentCache`, `offlinePackaging`                                                                                                                           |
| No pre-fetching                                                     | `forbids`: `prefetch`                                                                                                                                                      |
| Honor `Cache-Control` and ETags                                     | `memoryReuse` allowed with `respectCacheHeaders: true` (the engine's RAM tier reuses a tile only while its headers allow it, F260)                                         |
| Display only                                                        | `displayOnly: true`: a flag for the engine, which may draw the tiles but must not export or analyze them                                                                   |
| Google logo and attributions always visible, logo separate          | `requiredAttribution`: `Google` with the logo; viewport copyrights fetched per settled view (`viewportCopyright`), never per frame                                         |
| Session tokens, renewed before expiry                               | Sessions created by the adapter, renewed 60 s before `expiry` (`sessionRenewalSeconds` reports the session's lifetime) and after a 401/403                                 |
| Key required in URLs (no header form documented for tiles)          | The key is added by the adapter's transport only; the URL the engine sees, logs and coalesces on carries neither key nor session (F253)                                    |
| Billing region decides the terms                                    | `billingRegion: 'eea' \| 'other'` is required, never defaulted (F261); it selects `termsUrl` and the IDs that may be stored                                                |
| EEA terms allow caching Google IDs such as `pano_ID`                | `storableIds`: `placeId`, `panoId` for `eea`; `placeId` only for `other`                                                                                                   |
| Street View tiles under the same terms                              | `googleStreetView` uses the same profile: session token, attribution, nothing persisted                                                                                    |
| Free caps: 100,000 2D tiles and 100,000 Street View tiles per month | The live suite (`npm run test:live-sources`) requests at most 40 2D tiles, 4 Street View tiles and 6 session or metadata calls per run, and stops at the first quota error |

## Consequences

- The Google adapter is optional, outside every default (ADR 0015), and runs only with the customer's own key; live tests run only when `GOOGLE_MAPS_API_KEY` is set.
- The logo image must come from the application (Google's brand resources), passed as `logoUrl`; without it the required attribution is the text `Google`.
- F258–F260 (displaying the copyrights, the never-covered logo, cache-header reuse in the RAM tier) need the main track's credits API, attribution element and cache policy; the adapter provides the data they need.
