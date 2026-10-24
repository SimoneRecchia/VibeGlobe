// A consumer's own imagery adapter for an unusual fixture service that addresses tiles by quadkey (as some tile
// services do), written against the public engine API only.
import { WEB_MERCATOR_TILING, type TileCoord, type TileRequest, type TileTransport } from '@vibeglobe/core';
import { CUSTOM_PROFILE, type DescribedImagerySource, fetchTransport } from '@vibeglobe/sources';

/** The quadkey of a Web Mercator tile: one base-4 digit per level, most significant first. */
export function quadkey(coord: TileCoord): string {
  let key = '';
  for (let bit = coord.level - 1; bit >= 0; bit--) key += String(((coord.x >> bit) & 1) + 2 * ((coord.y >> bit) & 1));
  return key;
}

/** The fixture service's address. */
export const QUADKEY_SERVICE = 'https://quadkeys.test/';

/** Imagery from `<service><quadkey>.png`, levels 1 to 15. */
export function quadkeyImagery(
  transport: TileTransport = fetchTransport(),
  service = QUADKEY_SERVICE,
): DescribedImagerySource {
  return {
    id: 'quadkey',
    tiling: WEB_MERCATOR_TILING,
    minLevel: 1,
    maxLevel: 15,
    tileSizePx: 256,
    pixelRatio: 1,
    decoder: 'image',
    transport,
    attribution: [{ text: '© Quadkey Fixture Service' }],
    profile: CUSTOM_PROFILE,
    request(coord: TileCoord, out: TileRequest): TileRequest | 'noData' {
      if (coord.level < 1 || coord.level > 15) return 'noData';
      out.url = `${service}${quadkey(coord)}.png`;
      out.hostIndex = 0;
      return out;
    },
  };
}
