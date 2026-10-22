/**
 * Two third-party terrain adapters written against the public terrain adapter interface only (F132): what an
 * application would write for an encoding the engine does not know. They import nothing beyond the published package
 * entry points (`e2e/terrain-sources.spec.ts` checks it).
 */
import {
  heightGrid,
  heightmapGeometricErrorMeters,
  WEB_MERCATOR_TILING,
  WGS84,
  type TerrainSource,
  type TileCoord,
  type TileRequest,
} from '@vibeglobe/core';
import { fetchTransport } from '@vibeglobe/sources';

/** Samples per tile edge of both encodings. */
const SIZE = 256;
/** Grid cells the adapters decode to. */
const CELLS = 64;

/** A Web Mercator terrain source with a custom decoder over a URL template with `{z}`, `{x}` and `{y}`. */
function customTerrain(id: string, url: string, toHeights: (bytes: ArrayBuffer) => Float32Array): TerrainSource {
  const equatorMeters = 2 * Math.PI * WGS84.semiMajorAxisMeters;
  return {
    id,
    tiling: WEB_MERCATOR_TILING,
    minLevel: 0,
    maxLevel: 14,
    transport: fetchTransport(),
    datum: { kind: 'ellipsoid' },
    geometricErrorMeters: (level) => heightmapGeometricErrorMeters(level, SIZE, equatorMeters, 1),
    decoder: {
      kind: 'custom',
      decode: (bytes: ArrayBuffer) => heightGrid(toHeights(bytes), SIZE, CELLS),
    },
    request(coord: TileCoord, out: TileRequest): TileRequest | 'noData' {
      if (coord.level > 14) return 'noData';
      out.url = url.replace('{z}', String(coord.level)).replace('{x}', String(coord.x)).replace('{y}', String(coord.y));
      out.hostIndex = 0;
      return out;
    },
  };
}

/** Raw 24-bit RGB samples: height = (R × 65536 + G × 256 + B) / 100 − 50000 meters. */
export function rgb24Terrain(id: string, url: string): TerrainSource {
  return customTerrain(id, url, (bytes) => {
    const rgb = new Uint8Array(bytes);
    if (rgb.length !== SIZE * SIZE * 3) throw new RangeError(`an RGB tile needs ${SIZE * SIZE * 3} bytes`);
    const heights = new Float32Array(SIZE * SIZE);
    for (let i = 0; i < heights.length; i++)
      heights[i] = ((rgb[i * 3] ?? 0) * 65536 + (rgb[i * 3 + 1] ?? 0) * 256 + (rgb[i * 3 + 2] ?? 0)) / 100 - 50000;
    return heights;
  });
}

/** Raw little-endian float32 heights in meters. */
export function float32Terrain(id: string, url: string): TerrainSource {
  return customTerrain(id, url, (bytes) => {
    if (bytes.byteLength !== SIZE * SIZE * 4) throw new RangeError(`a float32 tile needs ${SIZE * SIZE * 4} bytes`);
    return new Float32Array(bytes.slice(0));
  });
}
