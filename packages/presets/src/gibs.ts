// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * NASA's Blue Marble from GIBS in EPSG:4326 (ADR 0182): the satellite composite's lowest levels and everywhere the
 * package has no tile, including the polar caps beyond Web Mercator's 85.05°, which only a geographic source can fill.
 * GIBS serves it as WMS GetMap in EPSG:4326, one request per geographic tile.
 */
import {
  GEOGRAPHIC_TILING,
  type ImagerySource,
  type TileCoord,
  type TileRectangleRad,
  type TileRequest,
} from '@vibeglobe/core';
import { fetchTransport } from '@vibeglobe/sources';
import type { PresetSourceRecord } from './sources.js';

const DEG = 180 / Math.PI;

/** The GetMap URL of the record's layer before its bounding box (WMS 1.3.0: latitude first in EPSG:4326). */
function getMapPrefix(record: PresetSourceRecord, layer: string): string {
  return (
    `${record.url ?? ''}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=${layer}&STYLES=` +
    '&FORMAT=image%2Fjpeg&TRANSPARENT=FALSE&CRS=EPSG%3A4326&WIDTH=256&HEIGHT=256&BBOX='
  );
}

/** The Blue Marble source of a GIBS record: whole world, its levels, JPEG tiles of 256 pixels. */
export function gibsBlueMarble(
  record: PresetSourceRecord,
  layer = 'BlueMarble_ShadedRelief_Bathymetry',
): ImagerySource {
  const prefix = getMapPrefix(record, layer);
  const extent: TileRectangleRad = { westRad: 0, southRad: 0, eastRad: 0, northRad: 0 };
  return {
    id: record.id,
    tiling: GEOGRAPHIC_TILING,
    minLevel: record.minLevel,
    maxLevel: record.maxLevel,
    tileSizePx: 256,
    pixelRatio: 1,
    transport: fetchTransport(),
    decoder: 'image',
    attribution: record.attribution,
    request(coord: TileCoord, out: TileRequest): TileRequest | 'noData' {
      if (coord.level < record.minLevel || coord.level > record.maxLevel) return 'noData';
      const e = GEOGRAPHIC_TILING.tileExtent(coord, extent);
      out.url = prefix + [e.southRad, e.westRad, e.northRad, e.eastRad].map((v) => (v * DEG).toFixed(9)).join(',');
      out.hostIndex = 0;
      return out;
    },
  };
}
