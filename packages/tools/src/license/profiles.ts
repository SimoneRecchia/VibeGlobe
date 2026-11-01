// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Built-in provider profiles: the license and attribution of every source the pipeline and the package builder know,
 * as re-verified in ADR 0025 (docs/adr/0025-default-data-licenses.md). The attribution strings here are the ones the
 * ADR records; `license-records.test.ts` checks that both agree.
 */

/** Terms of one provider profile. */
export interface ProviderProfile {
  /** Stable identifier used by configuration files. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** SPDX identifier, or a short name when the license has none. */
  license: string;
  /** Link to the license or terms page that was read. */
  licenseUrl: string;
  /** Date the terms were last read, `YYYY-MM-DD`. */
  termsReadDate: string;
  /** Exact attribution text outputs must carry. `{year}` is replaced with the data year. */
  attribution: string;
  /** Link to the dataset's source page. */
  sourceUrl: string;
  /** Whether the terms allow commercial use. */
  commercialUse: boolean;
  /** Whether the terms allow redistributing the data (self-hosting tiles, packages). */
  redistribution: boolean;
  /** Whether the terms allow storing the data in offline packages. */
  offlinePackaging: boolean;
  /** For a forbidden profile: the term that forbids it, quoted in refusals. */
  forbiddingTerm?: string;
}

const COPERNICUS_DEM_ATTRIBUTION = (product: string): string =>
  `produced using Copernicus ${product} © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved`;

/** Every built-in profile, allowed and forbidden. */
export const PROVIDER_PROFILES: readonly ProviderProfile[] = [
  {
    id: 'copernicus-dem-glo30',
    name: 'Copernicus DEM GLO-30 Public',
    license: 'Copernicus DEM licence (free, with attribution)',
    licenseUrl:
      'https://docs.sentinel-hub.com/api/latest/static/files/data/dem/resources/license/License-COPDEM-30.pdf',
    termsReadDate: '2026-10-21',
    attribution: COPERNICUS_DEM_ATTRIBUTION('WorldDEM-30'),
    sourceUrl: 'https://registry.opendata.aws/copernicus-dem/',
    commercialUse: true,
    redistribution: true,
    offlinePackaging: true,
  },
  {
    id: 'copernicus-dem-glo90',
    name: 'Copernicus DEM GLO-90',
    license: 'Copernicus DEM licence (free, with attribution)',
    licenseUrl:
      'https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM',
    termsReadDate: '2026-10-21',
    attribution: COPERNICUS_DEM_ATTRIBUTION('WorldDEM-90'),
    sourceUrl: 'https://registry.opendata.aws/copernicus-dem/',
    commercialUse: true,
    redistribution: true,
    offlinePackaging: true,
  },
  {
    id: 'esa-worldcover-s2-2021',
    name: 'ESA WorldCover Sentinel-2 RGBNIR yearly median composite 2021',
    license: 'CC-BY-4.0',
    licenseUrl: 'https://github.com/ESA-WorldCover/esa-worldcover-datasets#copyright-license',
    termsReadDate: '2026-10-22',
    attribution:
      '© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium',
    sourceUrl: 'https://registry.opendata.aws/esa-worldcover-vito-composites/',
    commercialUse: true,
    redistribution: true,
    offlinePackaging: true,
  },
  {
    id: 'eox-s2cloudless',
    name: 'Sentinel-2 cloudless by EOX, every edition',
    license: 'CC-BY-NC-SA-4.0 (2018 on); CC-BY-4.0 or EOX Commercial (2016)',
    licenseUrl: 'https://cloudless.eox.at/documentation/license',
    termsReadDate: '2026-11-01',
    attribution: 'Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH',
    sourceUrl: 'https://s2maps.eu',
    commercialUse: false,
    redistribution: false,
    offlinePackaging: false,
    forbiddingTerm:
      'the 2018 and later editions are licensed CC BY-NC-SA 4.0 (non-commercial use only), and EOX asks its ' +
      'commercial licence for any commercial use of the 2016 edition',
  },
  {
    id: 'natural-earth',
    name: 'Natural Earth raster',
    license: 'Public domain',
    licenseUrl: 'https://www.naturalearthdata.com/about/terms-of-use/',
    termsReadDate: '2026-10-21',
    attribution: 'Made with Natural Earth. Free vector and raster map data @ naturalearthdata.com.',
    sourceUrl: 'https://www.naturalearthdata.com/downloads/50m-raster-data/',
    commercialUse: true,
    redistribution: true,
    offlinePackaging: true,
  },
  {
    // ADR 0182: the weekly planet archive, not the public tile endpoint (limited to 3,000 tiles or 50 MB a download).
    id: 'openfreemap-planet',
    name: 'OpenFreeMap planet vector tiles (OpenStreetMap, OpenMapTiles schema)',
    license: 'ODbL-1.0 (data); CC-BY-4.0 (OpenMapTiles schema)',
    licenseUrl: 'https://openfreemap.org/tos',
    termsReadDate: '2026-10-26',
    attribution: 'OpenFreeMap © OpenMapTiles Data from OpenStreetMap',
    sourceUrl: 'https://openfreemap.org/quick_start/',
    commercialUse: true,
    redistribution: true,
    offlinePackaging: true,
  },
  {
    // ADR 0182: Terrarium tiles from each source's open terrain model; Copernicus GLO-30 up to level 12 in Europe.
    id: 'mapterhorn',
    name: 'Mapterhorn terrain (Terrarium)',
    license: "Each source's open licence (CC-BY-4.0, Copernicus DEM licence, Etalab-2.0, …)",
    licenseUrl: 'https://mapterhorn.com/attribution',
    termsReadDate: '2026-10-26',
    attribution: `© Mapterhorn (https://mapterhorn.com/attribution); ${COPERNICUS_DEM_ATTRIBUTION('WorldDEM-30')}`,
    sourceUrl: 'https://mapterhorn.com',
    commercialUse: true,
    redistribution: true,
    offlinePackaging: true,
  },
  {
    id: 'openstreetmap-extract',
    name: 'OpenStreetMap data extracts',
    license: 'ODbL-1.0',
    licenseUrl: 'https://www.openstreetmap.org/copyright',
    termsReadDate: '2026-10-21',
    attribution: '© OpenStreetMap contributors, data available under the Open Database License (ODbL)',
    sourceUrl: 'https://download.geofabrik.de/',
    commercialUse: true,
    redistribution: true,
    offlinePackaging: true,
  },
  {
    id: 'copernicus-sentinel-2',
    name: 'Copernicus Sentinel-2 data',
    license: 'Copernicus Sentinel data licence (free, full and open)',
    licenseUrl: 'https://sentinel.esa.int/documents/247904/690755/Sentinel_Data_Legal_Notice',
    termsReadDate: '2026-10-21',
    attribution: 'Contains modified Copernicus Sentinel data {year}',
    sourceUrl: 'https://registry.opendata.aws/sentinel-2-l2a-cogs/',
    commercialUse: true,
    redistribution: true,
    offlinePackaging: true,
  },
  {
    id: 'openstreetmap-tile-servers',
    name: 'Public OpenStreetMap tile servers',
    license: 'OSMF tile usage policy',
    licenseUrl: 'https://operations.osmfoundation.org/policies/tiles/',
    termsReadDate: '2026-10-21',
    attribution: '© OpenStreetMap contributors',
    sourceUrl: 'https://tile.openstreetmap.org/',
    commercialUse: false,
    redistribution: false,
    offlinePackaging: false,
    forbiddingTerm:
      'the OSMF tile usage policies forbid bulk downloading (fetching tiles ahead of time, tile archives, offline use) from its tile servers',
  },
  {
    id: 'google-maps-platform',
    name: 'Google Maps Platform tiles',
    license: 'Google Maps Platform Terms of Service',
    licenseUrl: 'https://developers.google.com/maps/documentation/tile/policies',
    termsReadDate: '2026-10-21',
    attribution: 'Google',
    sourceUrl: 'https://developers.google.com/maps/documentation/tile',
    commercialUse: true,
    redistribution: false,
    offlinePackaging: false,
    forbiddingTerm:
      'the Google Maps Platform terms forbid pre-fetching, caching or storing content outside the allowed temporary cache, and redistributing it',
  },
  {
    id: 'fixture',
    name: 'VibeGlobe test fixture',
    license: 'MPL-2.0',
    licenseUrl: 'https://mozilla.org/MPL/2.0/',
    termsReadDate: '2026-10-21',
    attribution: 'VibeGlobe test fixture',
    sourceUrl: 'https://github.com/SimoneRecchia/VibeGlobe',
    commercialUse: true,
    redistribution: true,
    offlinePackaging: true,
  },
];

/** Hosts that always refuse, whatever profile a configuration names (public OSM tiles, Google). */
export const FORBIDDEN_HOSTS: readonly { pattern: RegExp; profile: string }[] = [
  { pattern: /(^|\.)tile\.(openstreetmap\.(org|de|fr)|osm\.org)$/i, profile: 'openstreetmap-tile-servers' },
  { pattern: /(^|\.)(googleapis|google|gstatic|ggpht)\.com$/i, profile: 'google-maps-platform' },
];

/**
 * Layers whose terms forbid packaging, recognised in any source URL: EOX's Sentinel-2 cloudless, every edition
 * (`s2cloudless`, `s2cloudless-2020_3857`, …), whatever profile a configuration names.
 */
export const FORBIDDEN_URLS: readonly { pattern: RegExp; profile: string }[] = [
  { pattern: /s2cloudless/i, profile: 'eox-s2cloudless' },
];

/** Looks up a profile by id. */
export function findProfile(id: string): ProviderProfile | undefined {
  return PROVIDER_PROFILES.find((profile) => profile.id === id);
}

/** The attribution of a profile for a data year. */
export function attributionFor(profile: ProviderProfile, year: number | undefined): string {
  return profile.attribution.replace('{year}', year === undefined ? '' : String(year));
}
