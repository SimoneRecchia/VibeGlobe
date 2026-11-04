// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { TerrainSource, TileService } from '@vibeglobe/core';
import { heightmapTerrain, type ProviderProfile, SourceConfigError, withProfile, xyzImagery } from '@vibeglobe/sources';

const API = 'https://api.maptiler.com/';

/** MapTiler Cloud's rules (ADR 0186): its credit always shown, no offline packaging. */
const PROFILE: ProviderProfile = {
  id: 'maptiler',
  forbids: new Set(['offlinePackaging'] as const),
  respectCacheHeaders: true,
  requiredAttribution: { text: '© MapTiler © OpenStreetMap contributors', url: 'https://www.maptiler.com/copyright/' },
  termsAdr: 'docs/internal/adr/0186-provider-services.md',
};

/** The key, URL-encoded; refused when empty. */
function keyOf(key: string): string {
  if (!key.trim()) throw new SourceConfigError('missing-key', 'MapTiler: set `key` to the application’s API key');
  return encodeURIComponent(key);
}

/**
 * MapTiler's maps with the application's key: `map` 'satellite' (default) is the satellite imagery; another MapTiler
 * map id ('streets-v2', 'outdoor-v2', 'topo-v2', …) is drawn from its vector style.
 */
export function mapTilerTiles({
  key,
  map = 'satellite',
}: {
  readonly key: string;
  readonly map?: string;
}): TileService {
  const k = keyOf(key);
  if (map !== 'satellite') return { imagery: [], style: `${API}maps/${encodeURIComponent(map)}/style.json?key=${k}` };
  const url = `${API}tiles/satellite-v2/{z}/{x}/{y}.jpg?key=${k}`;
  return {
    imagery: [withProfile(xyzImagery({ id: 'maptiler-satellite', url, tileSizePx: 512, maxLevel: 20 }), PROFILE)],
  };
}

/** MapTiler's terrain (Terrain-RGB, levels 0 to 14) for the 3D view, with the application's key. */
export function mapTilerTerrain({ key }: { readonly key: string }): TerrainSource {
  const url = `${API}tiles/terrain-rgb-v2/{z}/{x}/{y}.webp?key=${keyOf(key)}`;
  return heightmapTerrain({
    id: 'maptiler-terrain',
    url,
    encoding: 'terrain-rgb',
    tileSizePx: 512,
    maxLevel: 14,
    profile: PROFILE,
  });
}
