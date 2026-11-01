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
- **Map, labels, roads, 3D buildings:** composed from OpenFreeMap's Liberty style into one style per selection. Its tiles go through `transformUrl(mode)`: in hybrid use the package's vector tiles up to its level and over the sea (a tile the package lacks is drawn from its nearest ancestor, F442), OpenFreeMap beyond them on land; offline, the style, its TileJSON, glyphs and sprites come from the package's mirror (`openfreemap/`).
- **Relief:** a hillshade of the same terrain tiles, read from the package and Mapterhorn by the same rule.

## Consequences

- An orthophoto is added once its terms are read: a row here, a record in `sources.ts`, and its country polygon as its `area`. Open question 34 asks the owner to allow the providers' hosts, or to confirm their terms.
- A change of terms means a new reading date, the row updated, and the test with it.
- OpenFreeMap and Mapterhorn publish no SLA. An application that needs one hosts the same tiles itself, from their PMTiles, as its package.

## Amendment, 2026-10-26: national and regional orthophotos

The owner asked for open orthophotos of Germany's Länder, Belgium, Denmark, Poland, Czechia, Slovenia, Croatia, Portugal, the Nordic and Baltic countries and Italy's regions, and for the ones above, each limited to its borders. The providers' hosts were still unreachable, but a web search returned quotes of their own pages (the provider's domain, its open-data portal, or its INSPIRE record). Those quotes are the evidence for this amendment, a stricter reading than the summaries rejected above: a service is included only when an official page states its licence for the product, the exact credit it requires is settled, and a Web Mercator (EPSG:3857) endpoint is known. Endpoints were cross-checked against the OpenStreetMap editor layer index, never used for licences.

Included, in `@vibeglobe/presets/orthophotos` (`EUROPE_ORTHOPHOTOS`, `europeOrthophotos()`), each a layer of its own clipped per pixel to its country's or Land's Natural Earth borders (F618) above the satellite composite:

| Service (id)                                               | Licence                                     | Exact credit                                                                 | Endpoint                                              | Evidence                                                      |
| ---------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------- |
| basemap.at Orthofoto, Austria (`basemap-at-orthofoto`)     | CC BY 4.0 (OGD Austria), commercial use     | `Datenquelle: basemap.at`, linked                                            | XYZ, `{z}/{y}/{x}`, level 20                          | https://basemap.at/en/                                        |
| SWISSIMAGE, Switzerland (`swisstopo-swissimage`)           | swisstopo open-data terms, commercial use   | `© swisstopo`                                                                | XYZ 3857, level 20; fair use up to 20,000 users a day | swisstopo terms of use; geo.admin.ch general terms (fair use) |
| ČÚZK Ortofoto, Czechia (`cz-cuzk-ortofoto`)                | CC BY 4.0 since 2023-07-01                  | `© ČÚZK`                                                                     | WMS layer `0`, EPSG:3857                              | geoportal.cuzk.gov.cz metadata and press release              |
| DGT Ortofotos 2025, mainland Portugal (`pt-dgt-ortos2025`) | CC BY 4.0                                   | `Informação geográfica cedida pela Direção-Geral do Território`              | WMS `Ortos2025-RGB`, EPSG:3857                        | dados.gov.pt, SNIG record                                     |
| LGLN DOP20, Niedersachsen (`de-ni-dop20`)                  | CC BY 4.0                                   | `LGLN (2026) Creative Commons Namensnennung – 4.0 International (CC BY 4.0)` | WMS `ni_dop20`, EPSG:3857                             | NUMIS records                                                 |
| Geobasis NRW DOP 10 cm (`de-nw-dop`)                       | Datenlizenz Deutschland – Zero 2.0          | none required; `Geobasis NRW, dl-de/zero-2-0` shown                          | WMS `nw_dop_rgb`, EPSG:3857                           | opengeodata.nrw.de                                            |
| GDI-Th DOP20, Thüringen (`de-th-dop20`)                    | Datenlizenz Deutschland – Namensnennung 2.0 | `© GDI-Th (2026) Datenlizenz Deutschland - Namensnennung - Version 2.0`      | WMS `th_dop`, EPSG:3857                               | geomis.geoportal-th.de record                                 |
| LGB DOP20c, Brandenburg and Berlin (`de-bb-be-dop20`)      | Datenlizenz Deutschland – Namensnennung 2.0 | `© GeoBasis-DE/LGB, dl-de/by-2-0`; `© Geoportal Berlin`                      | WMS `bebb_dop20c`, EPSG:3857                          | the service's capabilities                                    |
| LAiV DOP20, Mecklenburg-Vorpommern (`de-mv-dop20`)         | CC BY 4.0                                   | `© GeoBasis-DE/M-V 2026`                                                     | WMS `mv_dop`, EPSG:3857                               | LAiV service description                                      |
| LVermGeo DOP20, Sachsen-Anhalt (`de-st-dop20`)             | Datenlizenz Deutschland – Namensnennung 2.0 | `© GeoBasis-DE/LVermGeo ST`                                                  | WMS `lsa_lvermgeo_dop20_2`, EPSG:3857                 | LVermGeo open-data leaflet                                    |
| LVermGeoRP DOP20, Rheinland-Pfalz (`de-rp-dop20`)          | Datenlizenz Deutschland – Namensnennung 2.0 | `©GeoBasis-DE / LVermGeoRP (2026), dl-de/by-2-0`                             | WMS `rp_dop20`, EPSG:3857                             | INSPIRE record                                                |

The year in a credit is the year the data is obtained, as these providers ask; an application updates it with its own reading. The excluded services and why are in `EXCLUDED_SOURCES` (`packages/presets/src/sources.ts`): IGN BD ORTHO, PNOA, PDOK and Alto Adige 2023 because their exact credit is not settled (PNOA names each image's year; Etalab 2.0 asks for the update date), Croatia and Estonia for the same reason, several Länder because their EPSG:3857 endpoint or their records disagree, the federal BKG service (licensed for a fee until 2027), Denmark and Finland (keys required), Norway and Sweden (no open licence), Poland (no licence that allows redistribution), the Baltic and Italian services not verified, and Toscana as above. Alto Adige 2023 now has a CC BY 4.0 record, so only its credit is open. Open question 34 asks the owner to confirm this method and to settle the open credits.

## Amendment, 2026-10-27: map styles, the satellite chain and the package's levels

Problems the owner found with the preset in an application, and decisions:

- **ESA WorldCover online (Terrascope), excluded.** The owner asked for the WorldCover 2021 Sentinel-2 true colour layer of Terrascope's WMTS (`https://wmts.terrascope.be/`, layer `esa-worldcover-s2rgbnir-10m-2021-v2_tcc`) if its terms allow use from a commercial product. Its hosts are blocked here, so the terms were read through web-search quotes of Terrascope's and VITO's pages (2026-10-27). The quota page says the data and services are free for research and education and that commercial use "may entail associated costs"; VITO's page says the platform is free for all users, industry included; the terms say VITO may change the conditions at any time and end the platform without notice. No licence or usage limit specific to the WMTS was found. The data is CC BY 4.0, but the service's terms do not clearly allow free use from a commercial product, so it is left out (`EXCLUDED_SOURCES`) and open question 35 asks the owner.
- **NASA Blue Marble (GIBS), included** (`nasa-gibs-blue-marble`): NASA's imagery has no use restrictions (NASA's data and information policy; GIBS asks for an acknowledgement). Credit: `Imagery: NASA Blue Marble, from NASA's Global Imagery Browse Services (GIBS), part of NASA's ESDIS`. Read from web-search quotes of earthdata.nasa.gov, 2026-10-27. It is read through GIBS's WMS in EPSG:4326 (`BlueMarble_ShadedRelief_Bathymetry`, 256 px JPEG, up to level 7), because its WMTS matrices in EPSG:4326 do not match the engine's geographic tiling; geographic tiles cover the poles.
- **The satellite chain:** Blue Marble at the lowest levels and wherever nothing else is drawn, including the polar caps; the package's WorldCover composite from level 5 to 11; the application's own sources and the orthophotos above, from level 12. Blue Marble is the chain's first source from level 0, so its low levels stay in memory (F084) and a far view is never waiting for them.
- **Package levels (owner):** the package goes to level 11 on land and 8 over the sea, for every dataset (`europe.json`). Online, every source is asked for up to its own deepest level and magnified beyond it: the preset sets no zoom limit.
- **Map and Relief:** Map is a political map composed from OpenFreeMap's tiles (neutral land, blue water, country and region borders, place names), without land cover, land use or buildings; roads are their own overlay, off by default. Relief is the same map over a light tint by elevation (`color-relief`) and the hillshade. Their caps take the map's own colors.
- **Orthophotos:** every service starts at level 12 (`ORTHOPHOTO_MIN_LEVEL`), since they answer far views with white images, and a white tile counts as no data. The minimum per service and which services still answer badly could not be checked, as their hosts are blocked here: open question 34 (c). No service was removed.

## Amendment, 2026-10-28: the Blue Marble as a base layer, the package's water keyed out

In an application the package's WorldCover drew rectangles of another color and sharpness: its no-data water (RGB 54, 73, 90)
inside the package's box against the Blue Marble outside, and from level 9, where the package holds only Europe's land,
the sea and the land outside Europe on a magnified Blue Marble beside sharp land (KB-231). Tone matching (ADR 0044)
cannot fix it: the water is one flat color, not a tone. Satellite is now two layers: the Blue Marble below, everywhere,
and above it the app's sources and the package's WorldCover, whose pixels of the water color are transparent outside
Europe's land (a coverage area's `keyOutside`), fading over 12 tile pixels (`featherPx`, F630). The sea is the Blue
Marble at every level; WorldCover keeps its coastline and lakes. Above the package's level 11 the chain takes finer
online sources only when the app adds them (`orthophotos`, `addSources` from level 12); without them level 11 is
magnified (F632).

## Amendment, 2026-10-28: Satellite by zoom phases (supersedes the base-layer part of #57)

The owner asked for a far view like before #57, a linear transition by zoom without blocks, edges or jumps of color
or sharpness, and online detail beyond the package (F636). Satellite is now, from far to near:

| Levels (zoom at the center) | Shown                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| 0–4 (zoom < 3.5)            | The globe's base image (`baseImageryUrl`, Natural Earth `NE1_50M_SR_W` in the guides), offline included |
| 4.5–5 (zoom 3.5–4)          | NASA's Blue Marble fading in over it, the same over the whole view (`fadeIn`, F635)                     |
| 5–6 (zoom 4–5)              | The package's WorldCover fading in on Europe's land, its tones matched to the Blue Marble's (F633)      |
| 6–11                        | WorldCover on Europe's land; the Blue Marble on the sea, the polar regions and the land outside Europe  |
| 12–13 (zoom 11–12)          | The app's online sources (`addSources` from level 12, `orthophotos`) fading in, tones matched           |
| 13 and beyond               | Each online source to its own deepest level; elsewhere the deepest tile magnified with linear filtering |

`farLevels` (default 4) moves the first switch. This reverses #57's choice of the Blue Marble as the pinned base at the
lowest levels: the base image is local, sharp at those levels and the same offline and online. The Blue Marble is
asked of GIBS's EPSG:4326 WMS one image per Web Mercator tile, which the engine draws with rows linear in latitude
(`latitudeRows`, KB-232): as geographic tiles, a Mercator tile across a
geographic tile's edge showed a far coarser ancestor, up to 32 times along 45° N. Its levels end at 8 (about 430 m a
pixel at 45° N). Beyond 85.05° the caps take Natural Earth's colors. The package's water is keyed out everywhere, its
land clipped to Europe's with a 12-pixel fade (`keyEverywhere`, F636): with the water kept inside Europe's land
(KB-231's first fix), its simplified outline showed dark strips where it reaches over the sea. The Blue Marble keeps
its own colors (`harmonize: false`): one gain cannot bring both its sea and its land to the base image's, so the
switch is a cross-fade over half a level. Pinned levels now include the first level of a layer that starts deeper
(WorldCover's level 5 within Europe), a level per layer in turn (F634).

## Amendment, 2026-10-28: Italian orthophotos

The owner asked for free satellite imagery to levels 15–16 over Italy, Piemonte first, usable commercially and
redistributable. The research (`docs/research/italy-orthophotos.md`, all provider hosts blocked, terms read through
search quotes of the providers' pages) found none that passes for online use:

- Piemonte: AGEA 2015–2024 on `opengis.csi.it` (records: all rights reserved or terms unknown), ICE 2009–2011
  (conflicting CC BY versions, no licence in the owner's record), Torino 2023 (terms unknown): fail.
- Italy: the Geoportale Nazionale's orthophotos are excluded from its CC BY 4.0 (MASE FAQ): fail (`it-pcn`, as
  before). AGEA's 2022–2024 national imagery (20 cm) is reported CC BY 4.0 since 2026-08-26 but has no tile service:
  a candidate for an app-hosted package once AGEA's legal notes are read. Copernicus VHR, EOX s2cloudless, Esri, Google
  and Bing fail on their terms; Terrascope's 10 m gives no detail beyond level 13–14.
- Regions: Lombardia, Veneto, Valle d'Aosta, Sardegna, Toscana, Trentino's AGEA imagery and the others listed fail on
  AGEA's institutional terms or unstated licences. Emilia-Romagna's own 2022–2026 flights and Alto Adige 2023 state
  CC BY 4.0; their Web Mercator support (Emilia-Romagna), fixed credit (both) and CORS remain to be read at source.

Proposal, once a service passes: a record in `EUROPE_ORTHOPHOTOS` (`@vibeglobe/presets/orthophotos`), clipped to its
region with a soft border, from level 12 to its own deepest (19 for 20 cm), fading in over level 12 to 13 above the
package's WorldCover with its tones matched (F636). Without coverage the package's level 11 shows, magnified with
linear filtering. Open question 38 asks the owner to allow the hosts and to decide on self-hosted AGEA tiles.

## Amendment, 2026-10-28: tones matched only far away, the package over its box, no Blue Marble with a package

The owner found, in an application with the package (KB-234 to KB-238): a blue-gray cast on the land from level 5 to
14, as WorldCover was matched to the Blue Marble's darker tones even where the Blue Marble was a magnified 500 m
image; a hard edge at European Turkey, outside the land mask; a jump of tone between level 4.5 and 6 from the light
base image to the darker Blue Marble; a blotchy, striped sea beyond level 8, the Blue Marble magnified; and 404s of
Mapterhorn beyond its data. With a package Satellite is now:

| Levels (zoom at the center) | Land                                                                      | Sea                       |
| --------------------------- | ------------------------------------------------------------------------- | ------------------------- |
| 0–5 (zoom < 4)              | The base image                                                            | The base image            |
| 5–6 (zoom 4–5)              | WorldCover fading in over the package's box, in the base image's tones    | The base image            |
| 6–9 (zoom 5–8)              | WorldCover, the match fading out by zoom (`harmonizeFade`, F638)          | The base image            |
| 9 and beyond                | WorldCover in its own colors, then the online sources in their own (F638) | The base image, magnified |

- A layer's tone match takes a strength from the zoom, 1 to 0 over `harmonizeFade`, and the gain applied is the
  measured one to that power. A gain matched to the layer below never darkens (it is at least 1): data of a layer's
  own is not dimmed to a coarser image under it.
- WorldCover covers the package's box with a 12-pixel soft edge, its water keyed out; where the package holds Europe's
  land only (from level 9) its level 8 tiles are magnified, so Turkey's or Morocco's land has no edge (F639).
- The Blue Marble is left out with a package: the base image is the far view and the sea at every level, smooth when
  magnified. Online only, it fades in over level 4.5 to 5 in its own colors, as before.
- The online sources and orthophotos are not matched (`harmonize: false`): their colors are their own.
- Terrain is asked for no deeper than a tile its loader knows missing (F640): a service whose data ends at a shallower
  level costs one 404 a tile of its first missing level, not one a level.

## Amendment, 2026-10-31: Europe to zoom 15, the second reading of the orthophotos

The owner asked for imagery of all of Europe at zoom 15, from free sources only that allow commercial use and
redistribution, and delegated every decision to the agent. The providers' hosts are still blocked here, so the terms
were read again, country by country, through search quotes of the providers' own pages (their domain, open-data portal,
INSPIRE record or official gazette); endpoints were cross-checked against the OpenStreetMap editor layer index, never
used for licences. Two changes of method, decided for the owner:

- **Credits composed from the licence's own rule.** Where a licence asks only for the source and a date (Etalab 2.0,
  the Croatian open licence) or a CC BY attribution, and the provider fixes no text, the credit is the provider's name,
  product and year as that rule asks. An application updates the year with its own reading. This settles the exclusions
  of 2026-10-26 that stood on an unsettled credit (IGN, PNOA, PDOK, Alto Adige, Croatia, Estonia, Sachsen).
- **A free key is acceptable.** A service that needs a key free on registration is included and used only with the
  application's own key (`europeOrthophotos({ keys })`, the record's `keyParam`).

Included (`SECOND_READING_ORTHOPHOTOS` in `packages/presets/src/orthophoto-records-2026-10-31.ts`), each clipped to its
borders from Natural Earth (Belgium's regions are its map units, Bolzano its province), from level 12 to its own:

| Service (id)                                         | Licence                                       | Credit                                                                   | Endpoint, deepest level                      |
| ---------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------- |
| IGN BD ORTHO / ORTHO HR, France (`ign-bd-ortho`)     | Licence Ouverte Etalab 2.0                    | `© IGN 2026 – BD ORTHO®` (composed)                                      | Géoplateforme WMTS, PM matrix, 19            |
| PNOA Máxima Actualidad, Spain (`pnoa`)               | CC BY 4.0 (IGN conditions)                    | `PNOA-MA CC-BY 4.0 scne.es 2026` (IGN's short form)                      | WMTS GoogleMapsCompatible, 20                |
| PDOK Luchtfoto, Netherlands (`pdok-luchtfoto`)       | CC BY 4.0                                     | `Beeldmateriaal.nl, CC BY 4.0`                                           | WMTS `Actueel_orthoHR`, 21                   |
| Orthofotomozaïek, Flanders (`be-vlg-omw`)            | Vlaamse Open Data licentie v1.2               | `Bron: Orthofotomozaïek Vlaanderen 2025, Digitaal Vlaanderen`            | WMTS `GoogleMapsVL`, 21                      |
| SPW ORTHO_LAST, Wallonia (`be-wal-ortho-last`)       | CC BY 4.0                                     | `© SPW 2023`                                                             | WMS layer `0`, 19                            |
| ACT BD-L-ORTHO, Luxembourg (`lu-act-ortho`)          | CC0 1.0                                       | none required; `Administration du cadastre et de la topographie (ACT)`   | XYZ, 20                                      |
| Ortofoto 2023, Alto Adige (`alto-adige-2023`)        | CC BY 4.0                                     | `© Provincia autonoma di Bolzano – Alto Adige, Ortofoto 2023, CC BY 4.0` | WMS `Aerial-2023-RGB`, 19                    |
| DOP20, Bayern (`de-by-dop20`)                        | CC BY 4.0                                     | `Datenquelle: Bayerische Vermessungsverwaltung – www.geodaten.bayern.de` | WMS `by_dop20c`, 19                          |
| DOP20, Hessen (`de-he-dop20`)                        | Datenlizenz Deutschland – Zero 2.0            | none required; the HVBG's `Geobasisdaten ©` line shown                   | WMS `he_dop20_rgb`, 19                       |
| DOP20, Sachsen (`de-sn-dop20`)                       | Datenlizenz Deutschland – Namensnennung 2.0   | `Geodaten Sachsen, dl-de/by-2-0` (the service record's text)             | WMS `sn_dop_020`, 19                         |
| DOP20 summer, Hamburg (`de-hh-dop20`)                | Datenlizenz Deutschland – Namensnennung 2.0   | `Freie und Hansestadt Hamburg, … (LGV), dl-de/by-2-0`                    | WMS `dop_zeitreihe_belaubt`, 19              |
| Maanmittauslaitos orthophotos, Finland (`fi-mml`)    | CC BY 4.0                                     | `Contains data from the National Land Survey of Finland Orthophotos …`   | WMTS Pseudo-Mercator, 18; free key `api-key` |
| Maa- ja Ruumiamet orthophoto, Estonia (`ee-maaamet`) | the agency's open-data licence (as CC BY 4.0) | `Ortofoto: Maa- ja Ruumiamet 2026` (composed)                            | WMS `of10000`, 19                            |
| GUGiK Ortofotomapa, Poland (`pl-geoportal-orto`)     | free of charge, "for any purpose"             | `Główny Urząd Geodezji i Kartografii (geoportal.gov.pl)`                 | WMTS EPSG:3857, 19; no bulk downloading      |
| DGU DOF 2023–2024, Croatia (`hr-dgu-dof`)            | Otvorena dozvola (NN 67/2017)                 | `Izvor: Državna geodetska uprava, Digitalni ortofoto 2023.–2024.`        | WMS `OI.OrthoimageCoverage`, 19              |

Left out, in `EXCLUDED_SOURCES` with why: no Europe-wide source passes (Copernicus VHR 2021 and 2024 are commercial
mission imagery for eligible users only; EOX's Sentinel-2 cloudless is non-commercial from 2018 and its 2016 terms
conflict). Denmark, Slovenia, Slovakia, Latvia and Bremen have open licences but no Web Mercator endpoint could be
confirmed; Baden-Württemberg, Saarland and Schleswig-Holstein have conflicting records; the federal BKG service is paid
until 2027; Norway, Sweden, Lithuania, Hungary, Romania, Bulgaria, the western Balkans, Moldova, Ukraine, Belarus,
Russia, the United Kingdom, Ireland, Greece, Cyprus, Malta, Iceland and the small states have no open service; Italy's
AGEA imagery has no tile service, and Brussels' current licence was not confirmed.

The owner then fixed (2026-10-31) that the package keeps its weight, level 11 as before, and that the deeper levels
come online only, through the services' APIs, in online and hybrid use: the orthophotos pass through the offline engine
as network sources (KB-291). Where no orthophoto covers the land, the package's WorldCover composite (10 m) is the
detail, an application may still build it deeper at its own cost: `packageLevels.imagery`
reads it to the level the package was built to (F662), 13 for its full detail at about 27 GB, so zoom 15 shows it
magnified four times instead of level 11 sixteen times. Each service publishes its own availability; CORS could not be
checked from here for any of them, and a service that refuses a page's requests leaves the package's imagery in view.

For the land without an orthophoto, two online routes to 10 m imagery were checked and fail: the Copernicus Data Space
Ecosystem's Sentinel Hub (its Sentinel-2 cloudless mosaics) is free only within 10,000 processing units a month per
account, a commercial subscription beyond; and the WorldCover composite's own files on AWS cannot be read from a page,
as its bucket sends no CORS headers (`CORS is not enabled for this bucket`, checked 2026-10-31). Freemium services
(Esri, Mapbox, Google's Map Tiles API) are free only up to a monthly quota and proprietary: an application that accepts
their terms adds one with its key through `addSources`, limited to the area it fills.

## Amendment, 2026-10-31 (evening): Baden-Württemberg, Brussels and Denmark; Italy again

The owner asked again for the missing European services, Italy first, free and resellable to zoom 15. The provider
hosts were unreachable from the container (the proxy refused them), so licences come from search quotes of the
providers' pages and records, endpoints and layers from the OSM editor layer index or the providers' own guides. A
service is added only when its licence, its credit and its endpoint with the layer name are all known; the WMS sources
of the preset ask the layer without reading the capabilities, so a wrong layer name would fail every tile.

| Service (id)                                         | Licence                                                              | Credit                                          | Endpoint, deepest level                               |
| ---------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------- |
| LGL DOP20, Baden-Württemberg (`de-bw-dop20`)         | Datenlizenz Deutschland – Namensnennung 2.0 (LGL Open GeoData, 2024) | `Datenquelle: LGL, www.lgl-bw.de, dl-de/by-2-0` | WMS `IMAGES_DOP_20_RGB`, EPSG:3857, 19                |
| UrbIS Ortho, Brussels (`be-bru-urbis`)               | CC0 1.0 (datastore.brussels, Mobility Brussels)                      | none required; `Brussels UrbIS, Paradigm`       | WMS `Ortho`, EPSG:3857, 21                            |
| GeoDanmark Ortofoto forår, Denmark (`dk-geodanmark`) | CC BY 4.0 (Klimadatastyrelsen, Datafordeler terms)                   | `© Klimadatastyrelsen / GeoDanmark, CC BY 4.0`  | WMS `orto_foraar` in EPSG:4326, 20; free key `apikey` |

Baden-Württemberg's earlier exclusion (a permission for its Web Mercator WMS) predates the LGL's open data of 2024.
Brussels' borders are Natural Earth's map unit, as Belgium's other regions. Denmark's WMS offers no Web Mercator, so it
is asked in WGS84 (`OrthophotoService.crs`), as GIBS is.

Licence passes, endpoint or layer still to be read at source (open question 39): Slovenia (GURS DOF025, CC BY 4.0),
Slovakia (GKÚ Ortofotomozaika, CC BY 4.0), Lithuania (ORT10LT, CC BY 4.0 since its data.gov.lt record),
Schleswig-Holstein (the `OpenGBD` service, CC BY 4.0), Bremen (DOP20 2023, CC BY 4.0 since 2024) and Valle d'Aosta
(Ortofoto 2024, CC BY 4.0, credit `Estratto dall'Ortofoto 2024 di proprietà della Regione autonoma Valle d'Aosta`).
Saarland, Latvia's newer cycles, Greece, Cyprus, Madeira and Moldova stay uncertain; Sweden, Norway, the federal BKG
service, Hungary, Romania, Bulgaria, Ireland, the United Kingdom, Iceland, Serbia and the rest of the Balkans fail.

Italy (`docs/research/italy-orthophotos.md`, second reading): AGEA's 2022–2024 national imagery (20 cm) is CC BY 4.0
since 2026-08-26, commercial reuse included, but is still offered as downloads only, so it is the route to zoom 15 and
beyond for all of Italy as an application's own package (`addSources`), not an online source. The regions that serve
AGEA imagery (Veneto, Lombardia, Piemonte, Sardegna, Liguria, Trentino, Emilia-Romagna's AGEA layers) keep restrictive
terms; Toscana's records conflict; the others publish no open licence. Emilia-Romagna's own flights (CC BY 4.0) cover
part of the region with no confirmed reference system; Bologna's (CC BY 4.0 or ODbL) and Bergamo's (IODL 2.0) cover one
city each.

## Amendment, 2026-11-01: the city of Bologna

The Comune di Bologna publishes its yearly orthophotos (2017 to 2026, up to level 21) as an EPSG:3857 tile server. Its
specification states CC BY 4.0 ("ODbL compliant") and its open data page names ODbL: either allows commercial use and
redistribution with a credit, so the conflict is only which credit form applies, and `© Comune di Bologna, Ortofoto
2026` names the city as both ask. The service (`it-bologna-2026`, XYZ, level 21) covers the city only; Natural Earth has
no municipal borders, so a record may give a box instead of regions (`OrthophotoRecord.box`), and white or missing tiles
outside the city stay no data. The Emilia-Romagna region's own 2023–2024 flights over Bologna and Modena (CC BY 4.0)
and its October 2024 flood flight cover cities or flooded areas only, through WMS services whose layers could not be
read here.
