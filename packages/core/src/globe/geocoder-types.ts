// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { AbortSignalLike } from './imagery-runtime.js';
import type { GeoBounds } from './types.js';

/** A place an application's geocoder found (F208). */
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
 * A search provider the application supplies (F208): the engine and its packages bundle none and make no geocoding
 * request without one. `search` resolves the places matching `query`, empty when none; `signal` aborts a query the
 * user typed past.
 */
export interface Geocoder {
  search(
    query: string,
    options: { readonly signal: AbortSignalLike; readonly language: string },
  ): Promise<readonly GeocoderResult[]>;
}
