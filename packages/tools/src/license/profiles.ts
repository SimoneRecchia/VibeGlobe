/**
 * Built-in provider profiles: the license and attribution of every source the pipeline and the package builder know,
 * as re-verified in ADR 0024 (docs/adr/0024-default-data-licenses.md). The attribution strings here are the ones the
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

const COPERNICUS_DEM_ATTRIBUTION =
  'Produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved. The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM-30.';

/** Every built-in profile, allowed and forbidden. */
export const PROVIDER_PROFILES: readonly ProviderProfile[] = [
  {
    id: 'copernicus-dem-glo30',
    name: 'Copernicus DEM GLO-30 Public',
    license: 'Copernicus DEM licence (free, with attribution)',
    licenseUrl: 'https://spacedata.copernicus.eu/documents/20123/121286/CSCDA_ESA_Mission-specific+Annex_31_Oct_22.pdf',
    termsReadDate: '2026-10-21',
    attribution: COPERNICUS_DEM_ATTRIBUTION,
    sourceUrl: 'https://registry.opendata.aws/copernicus-dem/',
    commercialUse: true,
    redistribution: true,
    offlinePackaging: true,
  },
  {
    id: 's2cloudless-2016',
    name: 'Sentinel-2 cloudless 2016 by EOX',
    license: 'CC-BY-4.0',
    licenseUrl: 'https://cloudless.eox.at/pricing',
    termsReadDate: '2026-10-21',
    attribution:
      'Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016)',
    sourceUrl: 'https://s2maps.eu',
    commercialUse: true,
    redistribution: true,
    offlinePackaging: true,
  },
  {
    id: 's2cloudless-2018-or-later',
    name: 'Sentinel-2 cloudless 2018 and later editions by EOX',
    license: 'CC-BY-NC-SA-4.0',
    licenseUrl: 'https://cloudless.eox.at/license-non-commercial',
    termsReadDate: '2026-10-21',
    attribution: 'Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH',
    sourceUrl: 'https://s2maps.eu',
    commercialUse: false,
    redistribution: false,
    offlinePackaging: false,
    forbiddingTerm: 'the 2018 and later editions are licensed CC BY-NC-SA 4.0: non-commercial use only',
  },
  {
    id: 'natural-earth',
    name: 'Natural Earth raster',
    license: 'Public domain',
    licenseUrl: 'https://www.naturalearthdata.com/about/terms-of-use/',
    termsReadDate: '2026-10-21',
    attribution: 'Made with Natural Earth (public domain)',
    sourceUrl: 'https://www.naturalearthdata.com/downloads/50m-raster-data/',
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
    licenseUrl: 'https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice',
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
      'the OSMF tile usage policy forbids bulk downloading (scraping) and offline use of its tile servers',
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
    license: 'PolyForm-Noncommercial-1.0.0',
    licenseUrl: 'https://polyformproject.org/licenses/noncommercial/1.0.0/',
    termsReadDate: '2026-10-21',
    attribution: 'VibeGlobe test fixture',
    sourceUrl: 'https://github.com/SimoneRecchia/VibeGlobe',
    commercialUse: false,
    redistribution: true,
    offlinePackaging: true,
  },
];

/** Hosts that always refuse, whatever profile a configuration names (public OSM tiles, Google). */
export const FORBIDDEN_HOSTS: readonly { pattern: RegExp; profile: string }[] = [
  { pattern: /(^|\.)tile\.openstreetmap\.(org|de|fr)$/i, profile: 'openstreetmap-tile-servers' },
  { pattern: /(^|\.)(googleapis|google|gstatic|ggpht)\.com$/i, profile: 'google-maps-platform' },
];

/** Looks up a profile by id. */
export function findProfile(id: string): ProviderProfile | undefined {
  return PROVIDER_PROFILES.find((profile) => profile.id === id);
}

/** The attribution of a profile for a data year. */
export function attributionFor(profile: ProviderProfile, year: number | undefined): string {
  return profile.attribution.replace('{year}', year === undefined ? '' : String(year));
}
