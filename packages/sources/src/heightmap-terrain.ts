// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import {
  GEOGRAPHIC_TILING,
  heightmapGeometricErrorMeters,
  inCoverage,
  WEB_MERCATOR_TILING,
  WGS84,
  type TerrainSource,
  type TileCoord,
  type TileRectangleRad,
  type TileRequest,
  type TileTransport,
  type TimeoutsMs,
  type VerticalDatum,
} from '@vibeglobe/core';
import { fetchTransport } from './fetch-transport.js';
import { type Attribution, CUSTOM_PROFILE, type DescribedSource, type ProviderProfile } from './metadata.js';

/** Options of {@link heightmapTerrain}. */
export interface HeightmapTerrainOptions {
  /** Unique per engine instance. */
  id: string;
  /** URL template with `{z}`, `{x}`, `{y}` (`{-y}` for TMS rows counted from the south). */
  url: string;
  /** Terrarium (`(R × 256 + G + B / 256) − 32768` m, F129) or Mapbox Terrain-RGB (`−10000 + (R·65536 + G·256 + B) / 10` m, F130). */
  encoding: 'terrarium' | 'terrain-rgb';
  /** Tiling scheme: Web Mercator XYZ (default) or the two-root geographic pyramid. */
  tiling?: 'mercator' | 'geographic';
  minLevel?: number;
  maxLevel?: number;
  /** Pixels per tile edge, 256 (default) or 512. */
  tileSizePx?: number;
  /** What the heights are measured from; the WGS84 ellipsoid by default (F133). */
  datum?: VerticalDatum;
  /** The areas with data, radians; tiles outside are never requested. */
  coverage?: readonly TileRectangleRad[];
  /** The network transport; `fetchTransport()` by default. */
  transport?: TileTransport;
  maxRequestsPerHost?: number;
  multiplexed?: boolean;
  timeoutsMs?: TimeoutsMs;
  /** Credits shown while the terrain is in view (F254); none by default. */
  attribution?: readonly Attribution[];
  /** The provider's rules; everything enabled by default. */
  profile?: ProviderProfile;
}

/** A heightmap terrain source (Terrarium or Terrain-RGB PNG tiles) from an XYZ or TMS URL template. */
export function heightmapTerrain(options: HeightmapTerrainOptions): TerrainSource & DescribedSource {
  const tiling = options.tiling === 'geographic' ? GEOGRAPHIC_TILING : WEB_MERCATOR_TILING;
  const minLevel = options.minLevel ?? 0;
  const maxLevel = options.maxLevel ?? 15;
  const tileSizePx = options.tileSizePx ?? 256;
  const equatorMeters = 2 * Math.PI * WGS84.semiMajorAxisMeters;
  const extent: TileRectangleRad = { westRad: 0, southRad: 0, eastRad: 0, northRad: 0 };
  return {
    id: options.id,
    tiling,
    minLevel,
    maxLevel,
    ...(options.coverage ? { coverage: options.coverage } : {}),
    transport: options.transport ?? fetchTransport(),
    decoder: { kind: options.encoding },
    attribution: options.attribution ?? [],
    profile: options.profile ?? CUSTOM_PROFILE,
    datum: options.datum ?? { kind: 'ellipsoid' },
    geometricErrorMeters: (level) => heightmapGeometricErrorMeters(level, tileSizePx, equatorMeters, tiling.rootTilesX),
    ...(options.maxRequestsPerHost === undefined ? {} : { maxRequestsPerHost: options.maxRequestsPerHost }),
    ...(options.multiplexed === undefined ? {} : { multiplexed: options.multiplexed }),
    ...(options.timeoutsMs === undefined ? {} : { timeoutsMs: options.timeoutsMs }),
    request(coord: TileCoord, out: TileRequest): TileRequest | 'noData' {
      if (coord.level < minLevel || coord.level > maxLevel) return 'noData';
      if (options.coverage && !inCoverage(options.coverage, tiling.tileExtent(coord, extent))) return 'noData';
      const rows = tiling.rootTilesY * 2 ** coord.level;
      out.url = options.url
        .replace('{z}', String(coord.level))
        .replace('{x}', String(coord.x))
        .replace('{-y}', String(rows - 1 - coord.y))
        .replace('{y}', String(coord.y));
      out.hostIndex = 0;
      return out;
    },
  };
}
