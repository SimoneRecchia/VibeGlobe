// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { GeocoderResult, GeocoderService } from '@vibeglobe/core';

/** The languages komoot's public instance holds names in; other languages get the local names. */
const LANGUAGES = new Set(['de', 'en', 'fr']);

/** A feature of Photon's GeoJSON answer, as far as it is read; `extent` is west, north, east, south. */
interface PhotonFeature {
  readonly geometry?: { readonly coordinates?: readonly unknown[] };
  readonly properties?: Readonly<Record<string, unknown>> & { readonly extent?: readonly unknown[] };
}

/** Place search with Photon (OpenStreetMap data), komoot's public instance by default (ADR 0186). */
export class PhotonGeocoder implements GeocoderService {
  readonly #url: string;

  /** `url`: a Photon instance (default komoot's, for light use only: https://photon.komoot.io). */
  constructor(options: { readonly url?: string } = {}) {
    this.#url = (options.url ?? 'https://photon.komoot.io').replace(/\/$/, '');
  }

  /** The places matching `query`, at most five. */
  async search(query: string, options: Parameters<GeocoderService['search']>[1]): Promise<readonly GeocoderResult[]> {
    const lang = LANGUAGES.has(options.language) ? `&lang=${options.language}` : '';
    const response = await fetch(`${this.#url}/api/?q=${encodeURIComponent(query)}&limit=5${lang}`, {
      signal: options.signal as AbortSignal,
    });
    if (!response.ok) throw new Error(`Photon: HTTP ${response.status}`);
    const { features } = (await response.json()) as { features?: readonly PhotonFeature[] };
    return (features ?? []).flatMap(toResult);
  }
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);
const finite = (values: readonly unknown[] | undefined, count: number): values is readonly number[] =>
  values?.length === count && values.every(Number.isFinite);

/** A Photon feature as a result, or none when it has no coordinates. */
function toResult({ geometry, properties: p = {} }: PhotonFeature): GeocoderResult[] {
  const at = geometry?.coordinates;
  if (!finite(at, 2)) return [];
  const place = text(p['name']) ?? [text(p['street']), text(p['housenumber'])].filter(Boolean).join(' ');
  const parts = [place, text(p['city']), text(p['state']), text(p['country'])].filter((part) => part);
  const [west, north, east, south] = finite(p.extent, 4) ? p.extent : [];
  return [
    {
      label: [...new Set(parts)].join(', '),
      longitudeDeg: at[0] ?? 0,
      latitudeDeg: at[1] ?? 0,
      ...(west === undefined
        ? {}
        : { bounds: { westDeg: west, southDeg: south ?? 0, eastDeg: east ?? 0, northDeg: north ?? 0 } }),
    },
  ];
}
