// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The services an application plugs into the engine (ADR 0186): the engine knows no provider. Tiles are required; a
 * terrain (`TerrainSource`) and place search are optional, and without them their features are off.
 */
import type { ImageryLayerInput } from '../imagery/imagery-stack.js';
import type { AbortSignalLike } from './imagery-runtime.js';
import type { GeoBounds } from './types.js';

/** Where the map's tiles come from (required): raster layers, a vector style, or both, from any provider. */
export interface TileService {
  /** The raster layers, bottom first: sources (`xyzImagery`, …) or layers of sources; empty for a style-only map. */
  readonly imagery: readonly ImageryLayerInput[];
  /** A MapLibre style, its URL or JSON, drawn over the imagery: streets, labels, 3D buildings. */
  readonly style?: string | object;
}

/** A place a geocoder found (F208). */
export interface GeocoderResult {
  /** What a result list shows. */
  readonly label: string;
  readonly longitudeDeg: number;
  readonly latitudeDeg: number;
  /** The zoom to show it at; a search box picks one when omitted and no bounds are given. */
  readonly zoom?: number;
  /** The area of the place: a search box then fits it to the view. */
  readonly bounds?: GeoBounds;
}

/**
 * Place search (optional, F208): without it the search box accepts coordinates only and no geocoding request is made.
 * `search` resolves the places matching `query`, empty when none; `signal` aborts a query the user typed past.
 */
export interface GeocoderService {
  search(
    query: string,
    options: { readonly signal: AbortSignalLike; readonly language: string },
  ): Promise<readonly GeocoderResult[]>;
}
