// A consumer's own terrain adapter for the quadkey fixture service: raw little-endian 32-bit float heights in meters,
// 256 × 256 samples per tile, decoded by a custom decoder (F219). Public engine API only.
import {
  heightmapGeometricErrorMeters,
  WEB_MERCATOR_TILING,
  WGS84,
  type TerrainSource,
  type TileCoord,
  type TileRequest,
  type TileTransport,
} from '@vibeglobe/core';
import { heightGrid } from '@vibeglobe/core/decoders';
import { CUSTOM_PROFILE, fetchTransport, type DescribedSource } from '@vibeglobe/sources';
import { QUADKEY_SERVICE, quadkey } from './quadkey-imagery.ts';

/** Samples per tile edge. */
const SAMPLES = 256;
/** Grid cells the decoder produces. */
const CELLS = 64;

/** Terrain from `<service><quadkey>.f32`, levels 1 to 14. */
export function quadkeyTerrain(
  transport: TileTransport = fetchTransport(),
  service = QUADKEY_SERVICE,
): TerrainSource & DescribedSource {
  const equatorMeters = 2 * Math.PI * WGS84.semiMajorAxisMeters;
  return {
    id: 'quadkey-terrain',
    tiling: WEB_MERCATOR_TILING,
    minLevel: 1,
    maxLevel: 14,
    transport,
    attribution: [{ text: '© Quadkey Fixture Service' }],
    profile: CUSTOM_PROFILE,
    datum: { kind: 'ellipsoid' },
    geometricErrorMeters: (level) => heightmapGeometricErrorMeters(level, SAMPLES, equatorMeters, 1),
    decoder: {
      kind: 'custom',
      decode(bytes: ArrayBuffer) {
        if (bytes.byteLength !== SAMPLES * SAMPLES * 4)
          throw new RangeError(`a tile has ${String(SAMPLES * SAMPLES * 4)} bytes`);
        return heightGrid(new Float32Array(bytes.slice(0)), SAMPLES, CELLS);
      },
    },
    request(coord: TileCoord, out: TileRequest): TileRequest | 'noData' {
      if (coord.level < 1 || coord.level > 14) return 'noData';
      out.url = `${service}${quadkey(coord)}.f32`;
      out.hostIndex = 0;
      return out;
    },
  };
}
