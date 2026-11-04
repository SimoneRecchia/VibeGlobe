// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { GeocoderResult, GeocoderService } from '@vibeglobe/core';

/** The languages komoot's public instance holds names in; others get the local names. */
const LANGUAGES = new Set(['de', 'en', 'fr']);

/** A place of Photon's GeoJSON answer; `extent` is west, north, east, south. */
interface PhotonFeature {
  readonly geometry: { readonly coordinates: readonly [number, number] };
  readonly properties: Partial<Record<'name' | 'street' | 'housenumber' | 'city' | 'state' | 'country', string>> & {
    readonly extent?: readonly [number, number, number, number];
  };
}

/** Place search with Photon (OpenStreetMap data): `url`, an instance (default komoot's, for light use only). */
export function photonGeocoder({ url = 'https://photon.komoot.io' }: { readonly url?: string } = {}): GeocoderService {
  return {
    async search(query, { signal, language }) {
      const lang = LANGUAGES.has(language) ? `&lang=${language}` : '';
      const response = await fetch(`${url}/api/?q=${encodeURIComponent(query)}&limit=5${lang}`, {
        signal: signal as AbortSignal,
      });
      if (!response.ok) throw new Error(`Photon: HTTP ${response.status}`);
      return ((await response.json()) as { features: readonly PhotonFeature[] }).features.map(toResult);
    },
  };
}

function toResult({ geometry, properties: p }: PhotonFeature): GeocoderResult {
  const [longitudeDeg, latitudeDeg] = geometry.coordinates;
  const place = p.name ?? [p.street, p.housenumber].filter(Boolean).join(' ');
  const label = [...new Set([place, p.city, p.state, p.country].filter(Boolean))].join(', ');
  const e = p.extent;
  return {
    label,
    longitudeDeg,
    latitudeDeg,
    ...(e && { bounds: { westDeg: e[0], northDeg: e[1], eastDeg: e[2], southDeg: e[3] } }),
  };
}
