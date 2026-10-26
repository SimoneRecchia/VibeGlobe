# 0182. The Europe preset: free sources that allow commercial use and redistribution, re-verified

- Status: Accepted
- Date: 2026-10-26
- Milestone: M7

## Context

The owner asked (2026-10-26) for a Google Earth-like map of Europe that an application can ship. It uses only free sources whose terms allow commercial use, and redistribution where they go into the application's offline package. It works in hybrid use: the package on the application's own server up to a level, and online detail beyond it, loaded tile by tile. Before a source is included, its terms are read again and recorded here, as in ADR 0025. A source whose terms cannot be verified stays out and goes to `docs/open-questions.md`.

The terms were read on 2026-10-26. The build environment's network policy blocks most providers' hosts. These were read from the providers' own material:

- the OpenFreeMap website pages, in its repository `hyperknot/openfreemap`;
- the ESA WorldCover datasets README;
- the Natural Earth repository's licence;
- Mapterhorn's website and source catalogue, in its repository `mapterhorn/mapterhorn`;
- the Copernicus DEM licence and swisstopo's open-data terms, as PDFs kept in Mapterhorn's catalogue.

For the other providers only search-engine summaries of their pages were available. Those sources are excluded below.

## Options considered

1. **Include the national orthophotos on the strength of the summaries:** each summary suggests an open licence (CC BY 4.0, Etalab 2.0, OGD Austria). But the owner's rule asks for the terms themselves, and the exact attribution and any fair-use limits were not in the summaries.
2. **Ship the preset with the sources whose terms were read, and the mechanism for the rest:** polygon coverage (F610) and the application's own sources (`addSources`) let a verified orthophoto be added within its borders without changing the preset.

## Decision

Option 2. `packages/presets/src/sources.ts` records exactly these rows; `europe.test.ts` checks every included source has a licence, an attribution and this reading date.

| Source (preset id)                                                   | Licence                                                                                       | Commercial use | Redistribution, offline package                                                                                       | Online use                                                          | Exact attribution                                                                                                                                                                       | Terms read                                                                     |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| OpenFreeMap vector tiles and styles (`openfreemap`)                  | ODbL 1.0 (OpenStreetMap data); CC BY 4.0 (OpenMapTiles schema, styles); MIT (the service)     | Yes            | Yes, from the weekly planet PMTiles; downloads from the public tile endpoint are limited to 3,000 tiles or 50 MB each | Yes: no key, no registration, no limit on views or requests; no SLA | `OpenFreeMap © OpenMapTiles Data from OpenStreetMap` (the OpenFreeMap part is optional)                                                                                                 | https://openfreemap.org/tos (last updated 2026-10-14)                          |
| ESA WorldCover 2021 Sentinel-2 composite, 10 m (`europe-satellite`)  | CC BY 4.0                                                                                     | Yes            | Yes, with the credit                                                                                                  | No tile service: package only                                       | `© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium`                                                              | https://esa-worldcover.org/en/data-access, the datasets README                 |
| Mapterhorn terrain, Terrarium (`europe-terrain`)                     | Each source's open licence (CC BY 4.0, the Copernicus DEM licence, Etalab 2.0, …); code BSD-3 | Yes            | Yes, from its PMTiles (`pmtiles extract`)                                                                             | Yes: no terms of service, key or rate limit published; no SLA       | `© Mapterhorn` linking to https://mapterhorn.com/attribution                                                                                                                            | https://mapterhorn.com/attribution, its repository                             |
| Copernicus DEM GLO-30, in the package's terrain (`copernicus-glo30`) | Copernicus DEM licence (COP-DEM-GLO-30-F)                                                     | Yes            | Yes, with the notice, the no-liability sentence passed on                                                             | No tile service                                                     | `produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved` | the licence PDF, as in ADR 0025                                                |
| Natural Earth, the base image (`natural-earth`)                      | Public domain                                                                                 | Yes            | Yes                                                                                                                   | No tile service: the application hosts the base image               | `Made with Natural Earth` (optional)                                                                                                                                                    | https://www.naturalearthdata.com/about/terms-of-use/, the repository's licence |

Excluded:

| Source                                     | Why                                                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| basemap.at orthophoto (Austria)            | Terms not read: the host is blocked. The summaries suggest OGD Austria CC BY 4.0 with the credit "Datenquelle: basemap.at"                                                |
| swisstopo SWISSIMAGE (Switzerland), online | The open-data terms (read) allow commercial use and redistribution. The geo.admin.ch WMTS is under a fair-use limit whose current figure was not read                     |
| IGN BD ORTHO (France)                      | Terms not read: the host is blocked. The summaries suggest Etalab 2.0; the exact credit was not found                                                                     |
| PNOA (Spain)                               | Terms not read: the host is blocked. The summaries suggest CC BY 4.0 with the credit "PNOA <year> CC-BY 4.0 scne.es"                                                      |
| PDOK Luchtfoto (Netherlands)               | Terms not read: the host is blocked. The summaries suggest CC BY 4.0, crediting "Samenwerkingsverband Beeldmateriaal"                                                     |
| Alto Adige / Südtirol orthophoto 2023      | No licence specific to the 2023 orthophoto and no tiled endpoint found; earlier orthophotos were for internal use only                                                    |
| Regione Toscana orthophoto 2023            | The catalogue record says CC BY 4.0 and, in the same record, that the region holds the rights and that downloads are on request; only a WMS, no Web Mercator tile service |

How the sources are used:

- **Satellite:** the application's own sources first (`addSources`), each within its `area`, then the package's WorldCover composite, which is package-only (F611). Online-only use has no global satellite imagery until an orthophoto or the application's own source is added. The base image shows there.
- **Terrain:** one source. In hybrid use it is the package's Mapterhorn extract (GLO-30 heights up to level 12), then Mapterhorn online beyond it, on land only (F610's land mask from Natural Earth). The terrain cannot change while the globe runs, so 3D terrain is chosen when it is created.
- **Map, labels, roads, 3D buildings:** composed from OpenFreeMap's Liberty style into one style per selection. Offline, the style, its glyphs and sprites come from the package's copy.
- **Relief:** a hillshade of the same terrain tiles.

## Consequences

- An orthophoto is added once its terms are read: a row here, a record in `sources.ts`, and its country polygon as its `area`. Open question 34 asks the owner to allow the providers' hosts, or to confirm their terms.
- A change of terms means a new reading date, the row updated, and the test with it.
- OpenFreeMap and Mapterhorn publish no SLA. An application that needs one hosts the same tiles itself, from their PMTiles, as its package.
