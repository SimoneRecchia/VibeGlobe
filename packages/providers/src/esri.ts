// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { TileService } from '@vibeglobe/core';
import { type ProviderProfile, withProfile, xyzImagery } from '@vibeglobe/sources';

/** Esri's rules (ADR 0186): "Powered by Esri" always shown, no offline packaging. */
const PROFILE: ProviderProfile = {
  id: 'esri',
  forbids: new Set(['offlinePackaging'] as const),
  respectCacheHeaders: true,
  requiredAttribution: { text: 'Powered by Esri', url: 'https://www.esri.com/' },
  termsAdr: 'docs/internal/adr/0186-provider-services.md',
};

const PARTNERS =
  'Sources: Esri, TomTom, Garmin, FAO, NOAA, USGS, © OpenStreetMap contributors, and the GIS User Community';
/** Each map: its ArcGIS Online service, deepest level and data credit. */
const MAPS = {
  imagery: ['World_Imagery', 20, 'Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community'],
  streets: ['World_Street_Map', 19, PARTNERS],
  topo: ['World_Topo_Map', 19, PARTNERS],
} as const;

/** Esri's ArcGIS Online basemaps: `map` 'imagery' (default), 'streets' or 'topo'; `token`, the application's key. */
export function esriTiles({
  map = 'imagery',
  token,
}: { readonly map?: keyof typeof MAPS; readonly token?: string } = {}): TileService {
  const [service, maxLevel, credit] = MAPS[map];
  const query = token ? `?token=${encodeURIComponent(token)}` : '';
  const url = `https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/{z}/{y}/{x}${query}`;
  // Beyond its data the service sends a grey "Map data not yet available" tile: the level above shows (F691).
  const source = xyzImagery({ id: `esri-${map}`, url, maxLevel, blankTile: '#cccccc', blankShare: 0.9 });
  return { imagery: [withProfile(source, PROFILE, [{ text: credit }])] };
}
