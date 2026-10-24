// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { HttpStatusError } from '../archive-transport.js';
import { retryAfterMs } from '../fetch-transport.js';
import { type Attribution, SourceConfigError } from '../metadata.js';
import { type GoogleProfile, googleProfile, GoogleSession, type GoogleSourceOptions } from './google-provider.js';

/** Where to look for a panorama: its id, or a position and a search radius. */
export type StreetViewQuery =
  | { readonly panoId: string }
  | { readonly latitudeDeg: number; readonly longitudeDeg: number; readonly radiusMeters?: number };

/** Street View metadata of one panorama, as the Map Tiles API returns it. */
export interface StreetViewMetadata {
  readonly panoId: string;
  readonly latitudeDeg: number;
  readonly longitudeDeg: number;
  readonly imageWidthPx: number;
  readonly imageHeightPx: number;
  readonly tileWidthPx: number;
  readonly tileHeightPx: number;
  readonly headingDeg: number;
  readonly date?: string;
  /** The copyright the panorama must be shown with. */
  readonly copyright: string;
}

/** Street View through the Map Tiles API under the Google profile (F262). */
export interface GoogleStreetView {
  readonly profile: GoogleProfile;
  readonly attribution: readonly Attribution[];
  /** The panorama for a query, or undefined when there is none. */
  metadata(query: StreetViewQuery): Promise<StreetViewMetadata | undefined>;
  /**
   * One panorama tile, fetched with the session token and never persisted: the bytes are only for display, and
   * `cache: 'no-store'` keeps them out of the browser's HTTP cache. Undefined when the tile does not exist.
   */
  tile(panoId: string, zoom: number, x: number, y: number, signal?: AbortSignal): Promise<ArrayBuffer | undefined>;
}

function queryString(query: StreetViewQuery): string {
  if ('panoId' in query) return `panoId=${encodeURIComponent(query.panoId)}`;
  const radius = query.radiusMeters === undefined ? '' : `&radius=${query.radiusMeters}`;
  return `lat=${query.latitudeDeg}&lng=${query.longitudeDeg}${radius}`;
}

function parseMetadata(json: Record<string, unknown>): StreetViewMetadata | undefined {
  const number = (key: string): number => Number(json[key]);
  if (typeof json['panoId'] !== 'string') return undefined;
  return {
    panoId: json['panoId'],
    latitudeDeg: number('lat'),
    longitudeDeg: number('lng'),
    imageWidthPx: number('imageWidth'),
    imageHeightPx: number('imageHeight'),
    tileWidthPx: number('tileWidth'),
    tileHeightPx: number('tileHeight'),
    headingDeg: number('heading'),
    ...(typeof json['date'] === 'string' ? { date: json['date'] } : {}),
    copyright: typeof json['copyright'] === 'string' ? json['copyright'] : '',
  };
}

/**
 * Street View metadata and panorama tiles through the Map Tiles API (F262), under the same profile as the 2D tiles: a
 * `streetview` session renewed like theirs, Google's attribution, and nothing persisted. Resolves once the session
 * exists.
 */
export async function googleStreetView(options: GoogleSourceOptions): Promise<GoogleStreetView> {
  const profile = googleProfile(options.billingRegion, options.logoUrl);
  const session = new GoogleSession(options, { mapType: 'streetview' });
  try {
    await session.token();
  } catch (error) {
    throw new SourceConfigError('session-refused', `Google Street View: cannot create a session (${String(error)})`);
  }
  const get = async (path: string, signal?: AbortSignal): Promise<Response | undefined> => {
    for (let attempt = 0; ; attempt++) {
      const token = await session.token();
      const response = await session.get(session.withToken(`${session.base}${path}`, token), {
        cache: 'no-store',
        ...(signal ? { signal } : {}),
      });
      if (response.ok) return response;
      if (response.status === 404) return undefined;
      if ((response.status === 401 || response.status === 403) && attempt === 0) {
        await session.refused(token);
        continue;
      }
      throw new HttpStatusError(response.status, retryAfterMs(response.headers.get('Retry-After'), Date.now()));
    }
  };
  return {
    profile,
    attribution: [profile.requiredAttribution ?? { text: 'Google' }],
    async metadata(query) {
      const response = await get(`v1/streetview/metadata?${queryString(query)}`);
      return response ? parseMetadata((await response.json()) as Record<string, unknown>) : undefined;
    },
    async tile(panoId, zoom, x, y, signal) {
      const response = await get(`v1/streetview/tiles/${zoom}/${x}/${y}?panoId=${encodeURIComponent(panoId)}`, signal);
      return response ? response.arrayBuffer() : undefined;
    },
  };
}
