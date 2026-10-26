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
  /** Where it has data: Europe's land (online sources), or Europe's land and sea (the package). */
  readonly coverage: 'europe-land' | 'europe';
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

/** ESA WorldCover 2021 Sentinel-2 composite, 10 m: the satellite layer of the app's package. */
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
  minLevel: 0,
  maxLevel: 14,
  coverage: 'europe',
};

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
export const NATURAL_EARTH: PresetSourceRecord = {
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
  ESA_WORLDCOVER,
  OPENFREEMAP,
  MAPTERHORN,
  COPERNICUS_GLO30,
  NATURAL_EARTH,
];

const BLOCKED =
  "terms not verifiable on 2026-10-26: the provider's own terms pages could not be read from the build environment " +
  '(its network policy blocks the host); summaries suggest an open licence, to be confirmed (docs/open-questions.md)';

/** The online orthophotos left out, with why (ADR 0182). */
export const EXCLUDED_SOURCES: readonly ExcludedSource[] = [
  { id: 'basemap-at', name: 'basemap.at orthophoto (Austria)', reason: BLOCKED },
  {
    id: 'swissimage',
    name: 'swisstopo SWISSIMAGE (Switzerland)',
    reason:
      "online use not verifiable on 2026-10-26: swisstopo's open-data terms allow commercial use and redistribution, but " +
      'the geo.admin.ch WMTS is under a fair-use limit whose current figure could not be read (docs/open-questions.md)',
  },
  { id: 'ign-bd-ortho', name: 'IGN BD ORTHO (France)', reason: BLOCKED },
  { id: 'pnoa', name: 'PNOA (Spain)', reason: BLOCKED },
  { id: 'pdok-luchtfoto', name: 'PDOK Luchtfoto (Netherlands)', reason: BLOCKED },
  {
    id: 'alto-adige-2023',
    name: 'Alto Adige / Südtirol orthophoto 2023',
    reason:
      'no licence specific to the 2023 orthophoto and no tiled endpoint found; earlier orthophotos were for internal use only',
  },
  {
    id: 'toscana-2023',
    name: 'Regione Toscana orthophoto 2023',
    reason:
      'conflicting terms (CC BY 4.0 in the catalogue record, rights reserved by the region and download on request in the ' +
      'same record) and no Web Mercator tile service, only a WMS',
  },
];
