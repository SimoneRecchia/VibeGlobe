// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * NASA's Blue Marble from GIBS (ADR 0182), served as WMS GetMap in EPSG:4326: one image per Web Mercator tile, of the
 * tile's extent, its rows linear in latitude, which the engine draws as they are (`latitudeRows`, KB-232). Drawn as
 * geographic tiles, a Web Mercator surface tile across a geographic tile's edge showed the coarse geographic tile around
 * both, up to 32 times coarser along 45° N. Beyond Web Mercator's 85.05°, the polar caps take the base map's colors.
 */
import {
  WEB_MERCATOR_TILING,
  type ImagerySource,
  type TileCoord,
  type TileRectangleRad,
  type TileRequest,
} from '@vibeglobe/core';
import { fetchTransport, wmsGetMapUrl } from '@vibeglobe/sources';
import type { PresetSourceRecord } from './sources.js';

const DEG = 180 / Math.PI;

/** The Blue Marble source of a GIBS record: Web Mercator tiles of 256 pixels with rows linear in latitude, its levels. */
export function gibsBlueMarble(
  record: PresetSourceRecord,
  layer = 'BlueMarble_ShadedRelief_Bathymetry',
): ImagerySource {
  const extent: TileRectangleRad = { westRad: 0, southRad: 0, eastRad: 0, northRad: 0 };
  return {
    id: record.id,
    tiling: WEB_MERCATOR_TILING,
    latitudeRows: true,
    minLevel: record.minLevel,
    maxLevel: record.maxLevel,
    tileSizePx: 256,
    pixelRatio: 1,
    transport: fetchTransport(),
    decoder: 'image',
    attribution: record.attribution,
    request(coord: TileCoord, out: TileRequest): TileRequest | 'noData' {
      if (coord.level < record.minLevel || coord.level > record.maxLevel) return 'noData';
      const e = WEB_MERCATOR_TILING.tileExtent(coord, extent);
      out.url = wmsGetMapUrl(record.url ?? '', {
        layers: [layer],
        crs: 'EPSG:4326',
        bbox: [e.westRad * DEG, e.southRad * DEG, e.eastRad * DEG, e.northRad * DEG],
        widthPx: 256,
        heightPx: 256,
        format: 'image/jpeg',
        transparent: false,
      });
      out.hostIndex = 0;
      return out;
    },
  };
}
