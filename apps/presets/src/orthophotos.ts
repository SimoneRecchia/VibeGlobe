// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * `@vibeglobe/presets/orthophotos`: national and regional orthophoto services of Europe whose terms allow commercial
 * use and redistribution, read on 2026-10-26, 2026-10-31 and 2026-11-01 (ADR 0182). Each is a layer of its own, clipped per pixel to its country's
 * or region's borders (F618), so the satellite composite below shows outside it and at the borders between services.
 * Their borders load on demand, so this entry is apart from the preset's.
 *
 * @packageDocumentation
 */
import { type GeoJsonArea, type ImageryLayerOptions, type ImagerySource } from '@vibeglobe/core';
import { coverageArea } from '@vibeglobe/core/coverage';
import { wmsImagery, xyzImagery } from '@vibeglobe/sources';
import { countryBorders } from './countries.js';
import { onlineFade, type EuropeOpenOptions } from './europe.js';
import { FIRST_READING_ORTHOPHOTOS, type OrthophotoRecord } from './orthophoto-records.js';
import { SECOND_READING_ORTHOPHOTOS } from './orthophoto-records-2026-10-31.js';
import { THIRD_READING_ORTHOPHOTOS } from './orthophoto-records-2026-11-01.js';
import type { PresetSourceRecord } from './sources.js';

export { ORTHOPHOTO_MIN_LEVEL, type OrthophotoRecord, type OrthophotoService } from './orthophoto-records.js';

/** The orthophoto services included, in ADR 0182's order: those read on 2026-10-26, 2026-10-31 and 2026-11-01. */
export const EUROPE_ORTHOPHOTOS: readonly OrthophotoRecord[] = [
  ...FIRST_READING_ORTHOPHOTOS,
  ...SECOND_READING_ORTHOPHOTOS,
  ...THIRD_READING_ORTHOPHOTOS,
];

/** Options of {@link europeOrthophotos}. */
export interface EuropeOrthophotosOptions {
  /** Record ids to leave out. */
  readonly exclude?: readonly string[];
  /** The deepest level asked for, by record id. */
  readonly onlineMaxLevel?: Readonly<Record<string, number>>;
  /** The application's own keys of the services that need one (`keyParam`), by record id. */
  readonly keys?: Readonly<Record<string, string>>;
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
  if (record.box) {
    const [west, south, east, north] = record.box;
    coordinates.push([
      [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ],
    ]);
  }
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

/** The fade at an orthophoto's border, in pixels of its tiles (F636). */
const BORDER_FEATHER_PX = 8;

/** White filler a service sends where it has no data counts as no data, so the layer below shows (KB-215). */
const WHITE = [255, 255, 255] as const;

/** The engine source of a record, clipped to its area, from its first level, white tiles counted as no data. */
async function sourceOf(record: OrthophotoRecord, maxLevel: number, key?: string): Promise<ImagerySource> {
  const area = await areaOf(record);
  const keyed = record.keyParam !== undefined && key !== undefined ? { [record.keyParam]: key } : undefined;
  // A soft border, so the orthophoto fades into the imagery below over a few pixels (F636).
  const common = {
    id: record.id,
    maxLevel,
    attribution: record.attribution,
    area: { ...coverageArea(area), featherPx: BORDER_FEATHER_PX },
  };
  if (record.service.kind === 'xyz') {
    const query = keyed ? `${record.service.url.includes('?') ? '&' : '?'}${new URLSearchParams(keyed)}` : '';
    return xyzImagery({ ...common, url: record.service.url + query, minLevel: record.minLevel, blankTile: WHITE });
  }
  const source = await wmsImagery({
    ...common,
    url: record.service.url,
    layers: record.service.layer.split(','),
    format: 'image/jpeg',
    transparent: false,
    // Orthophotos carry no labels to keep whole across tile edges.
    gutterPx: 0,
    ...(record.service.crs ? { preferredCrs: record.service.crs } : {}),
    ...(keyed ? { parameters: keyed } : {}),
  });
  return {
    ...source,
    minLevel: record.minLevel,
    blankTile: { rgb: WHITE },
    request: (coord, out, pixelRatio) =>
      coord.level < record.minLevel ? 'noData' : source.request(coord, out, pixelRatio),
  };
}

/**
 * The orthophoto layers of the included services, each clipped to its country's or region's borders (loaded on
 * demand): pass them to `europeOpen({ orthophotos })`.
 */
export async function europeOrthophotos(options: EuropeOrthophotosOptions = {}): Promise<OrthophotoLayers> {
  // A service that needs a key is used only with the application's own.
  const records = EUROPE_ORTHOPHOTOS.filter(
    (r) => !(options.exclude ?? []).includes(r.id) && (r.keyParam === undefined || options.keys?.[r.id] !== undefined),
  );
  const sources = await Promise.all(
    records.map((r) =>
      sourceOf(r, Math.min(options.onlineMaxLevel?.[r.id] ?? r.maxLevel, r.maxLevel), options.keys?.[r.id]),
    ),
  );
  // Each fades in with the zoom over the WorldCover package's last level, in its own colors (F636, F638).
  const fadeIn = onlineFade();
  return {
    layers: sources.map((source) => ({ id: source.id, sources: [source], harmonize: false, fadeIn })),
    sources: records,
  };
}

/**
 * The preset's options with every online source it offers turned on (F637): the national and regional orthophotos
 * (loaded here, with their borders) on top of the options given. `europeOpen(await withAllOnlineSources({ ... }))`.
 */
export async function withAllOnlineSources(
  options: EuropeOpenOptions = {},
  orthophotos: EuropeOrthophotosOptions = {},
): Promise<EuropeOpenOptions> {
  return {
    ...options,
    orthophotos:
      options.orthophotos ??
      (await europeOrthophotos({
        ...orthophotos,
        ...(options.onlineMaxLevel ? { onlineMaxLevel: options.onlineMaxLevel } : {}),
      })),
  };
}
