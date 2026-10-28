// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The sources of the Europe preset with their terms as read on the date given (ADR 0182): only sources whose own terms
 * allow commercial use, and redistribution where they are packaged, are included; the others are listed with why.
 */
import type { Attribution } from '@vibeglobe/core';

/** Where a source's tiles come from in the preset. */
export type SourceTiers = 'package' | 'network' | 'all';

/** A source of the preset with its terms. */
export interface PresetSourceRecord {
  /** The engine source id (also the source id of its tiles in the app's offline package). */
  readonly id: string;
  readonly name: string;
  readonly kind: 'imagery' | 'terrain' | 'vector' | 'base-image';
  /** `package`: only from the app's offline package; `network`: only online; `all`: the package, then online. */
  readonly tiers: SourceTiers;
  readonly license: string;
  /** The provider's terms page that was read. */
  readonly termsUrl: string;
  /** The day the terms were read (ISO date). */
  readonly termsReadDate: string;
  /** The exact credits the terms ask for. */
  readonly attribution: readonly Attribution[];
  /** The levels the source serves online (`maxLevel` is the default of `onlineMaxLevel`). */
  readonly minLevel: number;
  readonly maxLevel: number;
  /**
   * Where it has data: Europe's land (online sources), Europe's land and sea (the package), or the whole world (NASA's
   * Blue Marble: the lowest levels and the polar caps).
   */
  readonly coverage: 'europe-land' | 'europe' | 'world';
  /** The online endpoint, as a tile URL template or a style URL; absent for package-only sources. */
  readonly url?: string;
}

/** A source left out of the preset, with why. */
export interface ExcludedSource {
  readonly id: string;
  readonly name: string;
  readonly reason: string;
}

/** The day this file's terms were read. */
export const TERMS_READ_DATE = '2026-10-26';

/** OpenStreetMap data in the OpenMapTiles schema, served by OpenFreeMap (vector tiles and styles). */
export const OPENFREEMAP: PresetSourceRecord = {
  id: 'openfreemap',
  name: 'OpenFreeMap (OpenStreetMap, OpenMapTiles schema)',
  kind: 'vector',
  tiers: 'network',
  license: 'ODbL 1.0 (OpenStreetMap data); CC BY 4.0 (OpenMapTiles schema and styles)',
  termsUrl: 'https://openfreemap.org/tos',
  termsReadDate: TERMS_READ_DATE,
  attribution: [
    { text: 'OpenFreeMap © OpenMapTiles Data from OpenStreetMap', url: 'https://www.openstreetmap.org/copyright' },
  ],
  minLevel: 0,
  maxLevel: 14,
  coverage: 'europe',
  url: 'https://tiles.openfreemap.org/styles/liberty',
};

/**
 * NASA's Blue Marble (shaded relief and bathymetry, 500 m) from GIBS in EPSG:4326, one image per Web Mercator tile
 * (KB-232): the satellite layer below the package, past the far levels: the sea, and the land outside Europe. Level 8
 * (about 430 m a pixel at 45° N) is the first finer than its data; the engine magnifies it beyond.
 */
export const NASA_GIBS_BLUE_MARBLE: PresetSourceRecord = {
  id: 'nasa-gibs-blue-marble',
  name: 'NASA Blue Marble, shaded relief and bathymetry (GIBS, EPSG:4326)',
  kind: 'imagery',
  tiers: 'network',
  license: 'NASA Earth science data: no restrictions on use (CC0 for NASA-produced data); acknowledgement requested',
  termsUrl: 'https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api',
  termsReadDate: '2026-10-27',
  attribution: [
    {
      text: "Imagery: NASA Blue Marble, from NASA's Global Imagery Browse Services (GIBS), part of NASA's ESDIS",
      url: 'https://www.earthdata.nasa.gov/gibs',
    },
  ],
  minLevel: 0,
  maxLevel: 8,
  coverage: 'world',
  url: 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi',
};

/**
 * ESA WorldCover 2021 Sentinel-2 composite, 10 m: the satellite layer of the app's package, from level 5 (below it the
 * Blue Marble shows the whole world) to the package's level, 11 by the owner's decision (2026-10-27); the engine
 * magnifies its deepest tiles beyond.
 */
export const ESA_WORLDCOVER: PresetSourceRecord = {
  id: 'europe-satellite',
  name: 'ESA WorldCover 2021 Sentinel-2 composite, 10 m',
  kind: 'imagery',
  tiers: 'package',
  license: 'CC BY 4.0',
  termsUrl: 'https://esa-worldcover.org/en/data-access',
  termsReadDate: TERMS_READ_DATE,
  attribution: [
    {
      text: '© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium',
      url: 'https://esa-worldcover.org',
    },
  ],
  minLevel: 5,
  maxLevel: 11,
  coverage: 'europe',
};

/**
 * The color the package gives WorldCover's water, sea and lakes alike: the pipeline's `noDataReflectance` (135, 245,
 * 372 out of 3000, `europe.json`) through its stretch `255 × (r / 3000) ^ (1 / 2)`. The preset keys it out over the
 * sea so the Blue Marble shows there (KB-231).
 */
export const WORLDCOVER_WATER_RGB: readonly [number, number, number] = [54, 73, 90];

/** Mapterhorn's Terrarium tiles (Copernicus GLO-30 in Europe up to level 12, national models beyond). */
export const MAPTERHORN: PresetSourceRecord = {
  id: 'europe-terrain',
  name: 'Mapterhorn terrain (Terrarium)',
  kind: 'terrain',
  tiers: 'all',
  license: "Each source's open licence (CC BY 4.0, the Copernicus DEM licence, Etalab 2.0, …), listed by Mapterhorn",
  termsUrl: 'https://mapterhorn.com/attribution',
  termsReadDate: TERMS_READ_DATE,
  attribution: [{ text: '© Mapterhorn', url: 'https://mapterhorn.com/attribution' }],
  minLevel: 0,
  maxLevel: 17,
  coverage: 'europe-land',
  url: 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp',
};

/** The Copernicus DEM GLO-30 heights the package's terrain holds (through Mapterhorn's extract, levels 0–12). */
export const COPERNICUS_GLO30: PresetSourceRecord = {
  id: 'copernicus-glo30',
  name: 'Copernicus DEM GLO-30',
  kind: 'terrain',
  tiers: 'package',
  license: 'Copernicus DEM licence (COP-DEM-GLO-30-F, free, full and open)',
  termsUrl:
    'https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM',
  termsReadDate: TERMS_READ_DATE,
  attribution: [
    {
      text:
        'produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 ' +
        'provided under COPERNICUS by the European Union and ESA; all rights reserved',
    },
  ],
  minLevel: 0,
  maxLevel: 12,
  coverage: 'europe',
};

/** Natural Earth: the base image the app hosts, shown before any tile and at the lowest levels. */
const NATURAL_EARTH: PresetSourceRecord = {
  id: 'natural-earth',
  name: 'Natural Earth',
  kind: 'base-image',
  tiers: 'package',
  license: 'Public domain',
  termsUrl: 'https://www.naturalearthdata.com/about/terms-of-use/',
  termsReadDate: TERMS_READ_DATE,
  attribution: [{ text: 'Made with Natural Earth', url: 'https://www.naturalearthdata.com' }],
  minLevel: 0,
  maxLevel: 4,
  coverage: 'europe',
};

/** Every included source. */
export const EUROPE_SOURCES: readonly PresetSourceRecord[] = [
  NASA_GIBS_BLUE_MARBLE,
  ESA_WORLDCOVER,
  OPENFREEMAP,
  MAPTERHORN,
  COPERNICUS_GLO30,
  NATURAL_EARTH,
];

const CREDIT =
  'licence verified (commercial use and redistribution allowed), but the exact credit the provider requires is not ' +
  'settled: ';
const ENDPOINT = 'licence verified, but its Web Mercator (EPSG:3857) endpoint or layer was not confirmed';

/**
 * The online orthophotos left out, with why (ADR 0182, terms read 2026-10-26). The included ones are in
 * `@vibeglobe/presets/orthophotos`.
 */
export const EXCLUDED_SOURCES: readonly ExcludedSource[] = [
  {
    id: 'terrascope-worldcover-s2-tcc',
    name: 'Terrascope WMTS, ESA WorldCover 2021 S2 true colour (esa-worldcover-s2rgbnir-10m-2021-v2_tcc)',
    reason:
      "Terrascope's documentation (read 2026-10-27) offers its data and services free of charge for research and " +
      'education and says commercial use may entail costs; its terms of use, which VITO may change at any time and ' +
      'which name no licence for the WMTS, could not be read in full (host blocked): commercial use not confirmed',
  },
  { id: 'ign-bd-ortho', name: 'IGN BD ORTHO (France)', reason: `${CREDIT}Etalab 2.0 asks for the update date` },
  { id: 'pnoa', name: 'PNOA Máxima Actualidad (Spain)', reason: `${CREDIT}it names each image's year, which varies` },
  { id: 'pdok-luchtfoto', name: 'PDOK Luchtfoto (Netherlands)', reason: `${CREDIT}no fixed text is given` },
  { id: 'alto-adige-2023', name: 'Alto Adige / Südtirol orthophoto 2023', reason: `${CREDIT}no fixed text is given` },
  { id: 'hr-dgu-dof', name: 'DGU DOF (Croatia)', reason: `${CREDIT}no fixed text is given` },
  { id: 'ee-maaamet', name: 'Maa-amet orthophoto (Estonia)', reason: `${CREDIT}the agency was renamed` },
  { id: 'de-sn-dop20', name: 'GeoSN DOP20 (Sachsen)', reason: `${CREDIT}two records give different texts` },
  { id: 'de-sl-dop20', name: 'LVGL DOP20 (Saarland)', reason: `${CREDIT}two records give different texts` },
  { id: 'de-by-dop20', name: 'DOP20 (Bayern)', reason: ENDPOINT },
  { id: 'de-he-dop20', name: 'DOP20 (Hessen)', reason: ENDPOINT },
  { id: 'de-sh-dop20', name: 'DOP20 OpenGBD (Schleswig-Holstein)', reason: ENDPOINT },
  { id: 'de-hh-dop20', name: 'DOP20 (Hamburg)', reason: ENDPOINT },
  { id: 'si-gurs-dof', name: 'GURS DOF (Slovenia)', reason: `${ENDPOINT} (only EPSG:3794)` },
  { id: 'it-er-ortofoto', name: 'Ortofoto RER (Emilia-Romagna)', reason: `${ENDPOINT}; no fixed credit` },
  {
    id: 'de-bw-dop20',
    name: 'LGL DOP20 (Baden-Württemberg)',
    reason: 'conflicting records: one INSPIRE record marks the service restricted, another open',
  },
  { id: 'de-hb-dop', name: 'DOP (Bremen)', reason: 'conflicting records: an open licence and an older one with fees' },
  {
    id: 'de-bkg-dop',
    name: 'BKG DOP20/DOP40 (Germany)',
    reason: 'licensed for a fee through the ZSGT; an open licence is announced from 2027-01-01',
  },
  {
    id: 'be-orthophotos',
    name: 'Flanders, Wallonia and Brussels orthophotos',
    reason: "the services' own terms (as distinct from the datasets') were not confirmed",
  },
  {
    id: 'dk-geodanmark',
    name: 'GeoDanmark orthophoto (Denmark)',
    reason: 'CC BY 4.0, but a token from a user registration is required and the WMTS is in UTM32 only',
  },
  {
    id: 'pl-geoportal-orto',
    name: 'Geoportal ORTO (Poland)',
    reason: 'free to use, but no named licence allows redistribution, and automatic downloading is prohibited',
  },
  { id: 'no-norge-i-bilder', name: 'Norge i bilder (Norway)', reason: 'Norge digitalt-lisens, not an open licence' },
  { id: 'se-lantmateriet', name: 'Lantmäteriet orthophoto (Sweden)', reason: 'no open licence found; access keys' },
  { id: 'fi-mml', name: 'MML orthophoto (Finland)', reason: 'CC BY 4.0, but the open interface needs an API key' },
  { id: 'is-natt', name: 'NÁTT aerial basemap (Iceland)', reason: 'CC BY 4.0, but no endpoint was found' },
  { id: 'lv-lgia', name: 'LĢIA orthophoto (Latvia)', reason: 'licence not confirmed by the provider' },
  {
    id: 'lt-ort10lt',
    name: 'ORT10LT (Lithuania)',
    reason: 'licence not verified; earlier terms barred redistribution',
  },
  {
    id: 'it-pcn',
    name: 'Geoportale Nazionale orthophotos (Italy)',
    reason: 'conflicting terms (CC BY 4.0 and CC BY-NC-SA) and imagery from 2006–2012',
  },
  {
    id: 'it-agea-regions',
    name: 'Lombardia, Veneto, Piemonte, Valle d’Aosta, Sardegna orthophotos',
    reason: 'recent orthophotos are AGEA: institutional use only, commercial use barred or not stated',
  },
  {
    id: 'toscana-2023',
    name: 'Regione Toscana orthophoto 2023',
    reason:
      'conflicting terms (CC BY 4.0 in the catalogue record, rights reserved by the region and download on request in the ' +
      'same record) and no Web Mercator tile service, only a WMS',
  },
  {
    id: 'it-other-regions',
    name: 'Trentino, Friuli Venezia Giulia, Sicilia, Lazio, Puglia, Liguria orthophotos',
    reason: 'no official licence or Web Mercator endpoint confirmed',
  },
];
