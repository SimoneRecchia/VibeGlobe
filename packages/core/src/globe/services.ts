// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The services an application plugs into the engine (ADR 0186): the engine knows no provider, only these interfaces.
 * Tiles are required; terrain and place search are optional, and without them the features they serve are off.
 */
import type { ImageryLayerInput } from '../imagery/imagery-stack.js';
import type { TerrainSource } from '../terrain/terrain-source.js';
import type { AbortSignalLike } from './imagery-runtime.js';
import type { GeoBounds } from './types.js';

/**
 * Where the map's tiles come from (required): any provider, built on the generic sources of `@vibeglobe/sources`
 * (`xyzImagery`, `wmtsImagery`, `pmtilesImagery`, …) or on a source of its own. Read once, when the globe is created.
 */
export interface TileService {
  /** The raster layers, bottom first: sources, or layers of sources with their options; empty for a style-only map. */
  imagery(): readonly ImageryLayerInput[];
  /**
   * Optional: a MapLibre style (its URL or JSON) of vector tiles drawn over the imagery: streets, labels, 3D buildings.
   * Undefined for a map without one.
   */
  style?(): string | object | undefined;
  /** Optional: rewrites every URL the style leads to before it is requested (a key, a mirror). */
  transformUrl?(url: string): string;
}

/** The relief of the 3D view (optional): without it the surface is the WGS84 ellipsoid. */
export interface TerrainService {
  /** The terrain the surface is displaced to: `heightmapTerrain`, `quantizedMeshTerrain` or a source of its own. */
  terrain(): TerrainSource;
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
