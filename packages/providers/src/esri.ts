// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { ImageryLayerInput, TileService } from '@vibeglobe/core';
import { type ProviderProfile, withProfile, xyzImagery } from '@vibeglobe/sources';

/** Esri's rules (ADR 0186): "Powered by Esri" always shown, no offline packaging. */
export const ESRI_PROFILE: ProviderProfile = Object.freeze({
  id: 'esri',
  forbids: new Set(['offlinePackaging'] as const),
  respectCacheHeaders: true,
  requiredAttribution: { text: 'Powered by Esri', url: 'https://www.esri.com/' },
  termsAdr: 'docs/internal/adr/0186-provider-services.md',
});

const PARTNERS =
  'Sources: Esri, TomTom, Garmin, FAO, NOAA, USGS, © OpenStreetMap contributors, and the GIS User Community';
/** Each map: its ArcGIS Online service, deepest level and data credit. */
const MAPS = {
  imagery: ['World_Imagery', 20, 'Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community'],
  streets: ['World_Street_Map', 19, PARTNERS],
  topo: ['World_Topo_Map', 19, PARTNERS],
} as const;

/** Options of {@link EsriTiles}. */
export interface EsriTilesOptions {
  /** 'imagery' (default), 'streets' or 'topo'. */
  readonly map?: keyof typeof MAPS;
  /** The application's ArcGIS access token or API key, sent with every tile request. */
  readonly token?: string;
}

/** Esri's ArcGIS Online basemaps: World Imagery, Street Map or Topographic. */
export class EsriTiles implements TileService {
  readonly #map: keyof typeof MAPS;
  readonly #token: string | undefined;

  constructor(options: EsriTilesOptions = {}) {
    this.#map = options.map ?? 'imagery';
    this.#token = options.token;
  }

  /** The basemap's tiles. */
  imagery(): readonly ImageryLayerInput[] {
    const [service, maxLevel, credit] = MAPS[this.#map];
    const token = this.#token ? `?token=${encodeURIComponent(this.#token)}` : '';
    const source = xyzImagery({
      id: `esri-${this.#map}`,
      url: `https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/{z}/{y}/{x}${token}`,
      maxLevel,
      // Beyond its data the service sends a grey "Map data not yet available" tile: the level above shows (F691).
      blankTile: '#cccccc',
      blankShare: 0.9,
    });
    return [withProfile(source, ESRI_PROFILE, [{ text: credit }])];
  }
}
