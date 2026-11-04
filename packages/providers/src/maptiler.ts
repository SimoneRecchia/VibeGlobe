// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { ImageryLayerInput, TerrainService, TerrainSource, TileService } from '@vibeglobe/core';
import { heightmapTerrain, type ProviderProfile, SourceConfigError, withProfile, xyzImagery } from '@vibeglobe/sources';

const API = 'https://api.maptiler.com/';

/** MapTiler Cloud's rules (ADR 0186): its credit always shown, no offline packaging; the key is the application's. */
export const MAPTILER_PROFILE: ProviderProfile = Object.freeze({
  id: 'maptiler',
  forbids: new Set(['offlinePackaging'] as const),
  respectCacheHeaders: true,
  requiredAttribution: { text: '© MapTiler © OpenStreetMap contributors', url: 'https://www.maptiler.com/copyright/' },
  termsAdr: 'docs/internal/adr/0186-provider-services.md',
});

/** The key, URL-encoded; refused when empty. */
function keyOf(key: string): string {
  if (typeof key !== 'string' || key.trim() === '')
    throw new SourceConfigError('missing-key', 'MapTiler: set `key` to the application’s MapTiler API key');
  return encodeURIComponent(key);
}

/** Options of {@link MapTilerTiles}. */
export interface MapTilerTilesOptions {
  /** The application's MapTiler API key. */
  readonly key: string;
  /**
   * 'satellite' (default), the satellite imagery; or the id of a MapTiler map drawn from its vector style, such as
   * 'streets-v2', 'outdoor-v2', 'topo-v2', 'basic-v2' or 'dataviz'.
   */
  readonly map?: string;
}

/** MapTiler's maps: the satellite imagery, or a map from its vector style (streets, labels, 3D buildings). */
export class MapTilerTiles implements TileService {
  readonly #key: string;
  readonly #map: string;

  constructor(options: MapTilerTilesOptions) {
    this.#key = keyOf(options.key);
    this.#map = options.map ?? 'satellite';
  }

  /** The satellite imagery; none for a vector map. */
  imagery(): readonly ImageryLayerInput[] {
    if (this.#map !== 'satellite') return [];
    const source = xyzImagery({
      id: 'maptiler-satellite',
      url: `${API}tiles/satellite-v2/{z}/{x}/{y}.jpg?key=${this.#key}`,
      tileSizePx: 512,
      maxLevel: 20,
    });
    return [withProfile(source, MAPTILER_PROFILE)];
  }

  /** The vector map's style; none for the satellite imagery. */
  style(): string | undefined {
    return this.#map === 'satellite'
      ? undefined
      : `${API}maps/${encodeURIComponent(this.#map)}/style.json?key=${this.#key}`;
  }
}

/** MapTiler's terrain (Terrain-RGB, levels 0 to 14) for the 3D view. */
export class MapTilerTerrain implements TerrainService {
  readonly #key: string;

  constructor(options: { readonly key: string }) {
    this.#key = keyOf(options.key);
  }

  /** The Terrain-RGB heights. */
  terrain(): TerrainSource {
    return heightmapTerrain({
      id: 'maptiler-terrain',
      url: `${API}tiles/terrain-rgb-v2/{z}/{x}/{y}.webp?key=${this.#key}`,
      encoding: 'terrain-rgb',
      tileSizePx: 512,
      maxLevel: 14,
      attribution: [MAPTILER_PROFILE.requiredAttribution ?? { text: '' }],
      profile: MAPTILER_PROFILE,
    });
  }
}
