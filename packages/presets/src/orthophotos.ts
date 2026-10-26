// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * `@vibeglobe/presets/orthophotos`: national and regional orthophoto services of Europe whose terms allow commercial
 * use and redistribution, read on 2026-10-26 (ADR 0182). Each is a layer of its own, clipped per pixel to its country's
 * or region's borders (F618), so the satellite composite below shows outside it and at the borders between services.
 * Their borders load on demand, so this entry is apart from the preset's.
 *
 * @packageDocumentation
 */
import type { GeoJsonArea, ImageryLayerOptions, ImagerySource } from '@vibeglobe/core';
import { wmsImagery, xyzImagery } from '@vibeglobe/sources';
import { countryBorders } from './countries.js';
import { TERMS_READ_DATE, type PresetSourceRecord } from './sources.js';

/** How an orthophoto service is reached: an XYZ template, or a WMS GetMap URL and layer (both in EPSG:3857). */
export type OrthophotoService =
  | { readonly kind: 'xyz'; readonly url: string }
  | { readonly kind: 'wms'; readonly url: string; readonly layer: string };

/** An orthophoto service with its terms and where it has data. */
export interface OrthophotoRecord extends PresetSourceRecord {
  readonly service: OrthophotoService;
  /** The ISO 3166 codes of the countries or regions it covers (`@vibeglobe/presets/countries`). */
  readonly regions: readonly string[];
  /** Only the polygons within this box (west, south, east, north in degrees): mainland Portugal, not its islands. */
  readonly within?: readonly [number, number, number, number];
  /** Online use limits the provider states. */
  readonly limits?: string;
}

/** A record of the shape every orthophoto shares. */
function ortho(
  record: Omit<OrthophotoRecord, 'kind' | 'tiers' | 'termsReadDate' | 'minLevel' | 'coverage' | 'url'>,
): OrthophotoRecord {
  return {
    ...record,
    kind: 'imagery',
    tiers: 'network',
    termsReadDate: TERMS_READ_DATE,
    minLevel: 0,
    coverage: 'europe-land',
    url: record.service.url,
  };
}

/** The orthophoto services included, in ADR 0182's order. */
export const EUROPE_ORTHOPHOTOS: readonly OrthophotoRecord[] = [
  ortho({
    id: 'basemap-at-orthofoto',
    name: 'basemap.at Orthofoto (Austria)',
    license: 'CC BY 4.0 (Open Government Data Austria)',
    termsUrl: 'https://basemap.at/en/',
    attribution: [{ text: 'Datenquelle: basemap.at', url: 'https://basemap.at' }],
    maxLevel: 20,
    regions: ['AT'],
    // Rows before columns in this service's paths.
    service: {
      kind: 'xyz',
      url: 'https://mapsneu.wien.gv.at/basemap/bmaporthofoto30cm/normal/google3857/{z}/{y}/{x}.jpeg',
    },
  }),
  ortho({
    id: 'swisstopo-swissimage',
    name: 'swisstopo SWISSIMAGE (Switzerland)',
    license: 'swisstopo open government data terms (commercial use and redistribution allowed)',
    termsUrl: 'https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices',
    attribution: [{ text: '© swisstopo', url: 'https://www.swisstopo.admin.ch' }],
    maxLevel: 20,
    regions: ['CH'],
    limits:
      'fair use: web applications averaging up to 20,000 users a day (geo.admin.ch); above that, contact swisstopo',
    service: {
      kind: 'xyz',
      url: 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/{z}/{x}/{y}.jpeg',
    },
  }),
  ortho({
    id: 'cz-cuzk-ortofoto',
    name: 'ČÚZK Ortofoto ČR (Czech Republic)',
    license: 'CC BY 4.0',
    termsUrl: 'https://geoportal.cuzk.gov.cz/Dokumenty/TZ_Ortofoto_CR.pdf',
    attribution: [{ text: '© ČÚZK', url: 'https://geoportal.cuzk.gov.cz' }],
    maxLevel: 20,
    regions: ['CZ'],
    service: { kind: 'wms', url: 'https://ags.cuzk.gov.cz/arcgis1/services/ORTOFOTO/MapServer/WMSServer', layer: '0' },
  }),
  ortho({
    id: 'pt-dgt-ortos2025',
    name: 'DGT Ortofotos 2025, 25 cm (mainland Portugal)',
    license: 'CC BY 4.0',
    termsUrl: 'https://dados.gov.pt/en/datasets/6a445f94aa49a7655e288cb7',
    attribution: [
      { text: 'Informação geográfica cedida pela Direção-Geral do Território', url: 'https://www.dgterritorio.gov.pt' },
    ],
    maxLevel: 19,
    regions: ['PT'],
    within: [-10, 36.5, -6, 42.5],
    service: { kind: 'wms', url: 'https://cartografia.dgterritorio.gov.pt/wms/ortos2025', layer: 'Ortos2025-RGB' },
  }),
  ortho({
    id: 'de-ni-dop20',
    name: 'LGLN DOP20 (Niedersachsen)',
    license: 'CC BY 4.0',
    termsUrl: 'https://numis.niedersachsen.de/trefferanzeige?docuuid=87890b7a-5a8a-4100-8a1e-78ced663a5d4',
    attribution: [{ text: 'LGLN (2026) Creative Commons Namensnennung – 4.0 International (CC BY 4.0)' }],
    maxLevel: 19,
    regions: ['DE-NI'],
    service: { kind: 'wms', url: 'https://opendata.lgln.niedersachsen.de/doorman/noauth/dop_wms', layer: 'ni_dop20' },
  }),
  ortho({
    id: 'de-nw-dop',
    name: 'Geobasis NRW DOP, 10 cm (Nordrhein-Westfalen)',
    license: 'Datenlizenz Deutschland – Zero – Version 2.0 (no credit required)',
    termsUrl: 'https://www.opengeodata.nrw.de/produkte/geobasis/lusat/akt/dop/dop_jp2_f10/',
    attribution: [{ text: 'Geobasis NRW, dl-de/zero-2-0' }],
    maxLevel: 20,
    regions: ['DE-NW'],
    service: { kind: 'wms', url: 'https://www.wms.nrw.de/geobasis/wms_nw_dop', layer: 'nw_dop_rgb' },
  }),
  ortho({
    id: 'de-th-dop20',
    name: 'GDI-Th DOP20 (Thüringen)',
    license: 'Datenlizenz Deutschland – Namensnennung – Version 2.0',
    termsUrl: 'https://geomis.geoportal-th.de/geonetwork/srv/api/records/10cbd9e4-8a84-4771-8ed1-a3cf66a01766',
    attribution: [{ text: '© GDI-Th (2026) Datenlizenz Deutschland - Namensnennung - Version 2.0' }],
    maxLevel: 19,
    regions: ['DE-TH'],
    service: { kind: 'wms', url: 'https://www.geoproxy.geoportal-th.de/geoproxy/services/DOP', layer: 'th_dop' },
  }),
  ortho({
    id: 'de-bb-be-dop20',
    name: 'LGB DOP20c (Brandenburg and Berlin)',
    license: 'Datenlizenz Deutschland – Namensnennung – Version 2.0',
    termsUrl: 'https://isk.geobasis-bb.de/mapproxy/dop20c/service/wms?REQUEST=GetCapabilities&SERVICE=WMS',
    attribution: [{ text: '© GeoBasis-DE/LGB, dl-de/by-2-0' }, { text: '© Geoportal Berlin' }],
    maxLevel: 19,
    regions: ['DE-BB', 'DE-BE'],
    service: { kind: 'wms', url: 'https://isk.geobasis-bb.de/mapproxy/dop20c/service/wms', layer: 'bebb_dop20c' },
  }),
  ortho({
    id: 'de-mv-dop20',
    name: 'LAiV DOP20 (Mecklenburg-Vorpommern)',
    license: 'CC BY 4.0',
    termsUrl: 'https://www.laiv-mv.de/static/LAIV/Geoinformation/Dateien/Geobasisdaten/Kurzbeschreibung_WMS_DOP.pdf',
    attribution: [{ text: '© GeoBasis-DE/M-V 2026' }],
    maxLevel: 19,
    regions: ['DE-MV'],
    service: { kind: 'wms', url: 'https://www.geodaten-mv.de/dienste/adv_dop', layer: 'mv_dop' },
  }),
  ortho({
    id: 'de-st-dop20',
    name: 'LVermGeo DOP20 (Sachsen-Anhalt)',
    license: 'Datenlizenz Deutschland – Namensnennung – Version 2.0',
    termsUrl:
      'https://www.geodatenportal.sachsen-anhalt.de/gfds/de/datei/download/id/26238,501/faltblatt_opendata_md.pdf',
    attribution: [{ text: '© GeoBasis-DE/LVermGeo ST' }],
    maxLevel: 19,
    regions: ['DE-ST'],
    service: {
      kind: 'wms',
      url: 'https://www.geodatenportal.sachsen-anhalt.de/wss/service/ST_LVermGeo_DOP_WMS_OpenData/guest',
      layer: 'lsa_lvermgeo_dop20_2',
    },
  }),
  ortho({
    id: 'de-rp-dop20',
    name: 'LVermGeoRP DOP20 (Rheinland-Pfalz)',
    license: 'Datenlizenz Deutschland – Namensnennung – Version 2.0',
    termsUrl: 'https://inspire-geoportal.ec.europa.eu/srv/api/records/e537df10-285f-2069-87a6-e8666d1cce1f',
    attribution: [{ text: '©GeoBasis-DE / LVermGeoRP (2026), dl-de/by-2-0' }],
    maxLevel: 19,
    regions: ['DE-RP'],
    service: { kind: 'wms', url: 'https://geo4.service24.rlp.de/wms/rp_dop20.fcgi', layer: 'rp_dop20' },
  }),
];

/** Options of {@link europeOrthophotos}. */
export interface EuropeOrthophotosOptions {
  /** Record ids to leave out. */
  readonly exclude?: readonly string[];
  /** The deepest level asked for, by record id. */
  readonly onlineMaxLevel?: Readonly<Record<string, number>>;
}

/** Orthophoto layers for `europeOpen({ orthophotos })`, with their records. */
export interface OrthophotoLayers {
  /** One layer per service, clipped to its borders: above the satellite composite, below the vector overlays. */
  readonly layers: readonly ImageryLayerOptions[];
  readonly sources: readonly PresetSourceRecord[];
}

/** The polygons of the record's regions, kept within its box when it has one. */
async function areaOf(record: OrthophotoRecord): Promise<GeoJsonArea> {
  const coordinates: number[][][][] = [];
  for (const region of record.regions) {
    const borders = await countryBorders(region);
    if (borders.type === 'MultiPolygon')
      for (const polygon of borders.coordinates) {
        const [west, south, east, north] = record.within ?? [-180, -90, 180, 90];
        const inside = polygon[0]?.every(
          ([lon = 0, lat = 0]) => lon >= west && lon <= east && lat >= south && lat <= north,
        );
        if (inside) coordinates.push(polygon.map((ring) => ring.map((p) => [...p])));
      }
  }
  return { type: 'MultiPolygon', coordinates };
}

/** The engine source of a record, clipped to its area. */
async function sourceOf(record: OrthophotoRecord, maxLevel: number): Promise<ImagerySource> {
  const area = await areaOf(record);
  const common = { id: record.id, maxLevel, attribution: record.attribution, area };
  if (record.service.kind === 'xyz') return xyzImagery({ ...common, url: record.service.url });
  return wmsImagery({
    ...common,
    url: record.service.url,
    layers: [record.service.layer],
    format: 'image/jpeg',
    transparent: false,
    // Orthophotos carry no labels to keep whole across tile edges.
    gutterPx: 0,
  });
}

/**
 * The orthophoto layers of the included services, each clipped to its country's or region's borders (loaded on
 * demand): pass them to `europeOpen({ orthophotos })`.
 */
export async function europeOrthophotos(options: EuropeOrthophotosOptions = {}): Promise<OrthophotoLayers> {
  const records = EUROPE_ORTHOPHOTOS.filter((r) => !(options.exclude ?? []).includes(r.id));
  const sources = await Promise.all(
    records.map((r) => sourceOf(r, Math.min(options.onlineMaxLevel?.[r.id] ?? r.maxLevel, r.maxLevel))),
  );
  return { layers: sources.map((source) => ({ id: source.id, sources: [source] })), sources: records };
}
