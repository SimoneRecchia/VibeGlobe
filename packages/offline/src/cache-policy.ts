// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * How long a downloaded tile may be reused (F277): `Cache-Control` and `Expires` decide, `no-store` is never
 * persisted, and a per-source override can only shorten what the headers allow.
 */

/** The headers of a response that matter to the cache. */
export interface CacheHeaders {
  readonly cacheControl: string | null;
  readonly expires: string | null;
  readonly date: string | null;
  readonly etag: string | null;
  readonly lastModified: string | null;
}

/** Per-source cache settings; values can only shorten what the headers and the provider allow. */
export interface SourceCachePolicy {
  /** Longest reuse without revalidation, in milliseconds. */
  readonly maxAgeMs?: number;
}

/** What the cache may do with one response. */
export interface Freshness {
  /** False for `no-store`: the tile is never written to browser storage. */
  readonly storable: boolean;
  /** Until when the tile may be reused without asking the server (epoch milliseconds). */
  readonly freshUntilMs: number;
}

/** Reuse time of responses without any freshness header (ADR 0033). */
export const DEFAULT_HEURISTIC_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function directives(cacheControl: string | null): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of (cacheControl ?? '').split(',')) {
    const [name, value] = part.trim().split('=');
    if (name) result.set(name.toLowerCase(), (value ?? '').replace(/"/g, ''));
  }
  return result;
}

/** The reuse time the headers allow, in milliseconds, or undefined when they say nothing about it. */
function headerMaxAgeMs(headers: CacheHeaders, nowMs: number): number | undefined {
  const parsed = directives(headers.cacheControl);
  if (parsed.has('no-cache')) return 0;
  const maxAge = parsed.get('s-maxage') ?? parsed.get('max-age');
  if (maxAge !== undefined) {
    const seconds = Number(maxAge);
    return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : 0;
  }
  if (headers.expires !== null) {
    const expires = Date.parse(headers.expires);
    // An invalid Expires means already expired (RFC 9111 §5.3).
    if (Number.isNaN(expires)) return 0;
    const date = headers.date === null ? Number.NaN : Date.parse(headers.date);
    return Math.max(0, expires - (Number.isNaN(date) ? nowMs : date));
  }
  return undefined;
}

/**
 * The freshness of a response received at `nowMs`. Without freshness headers the tile is reused for
 * `heuristicMaxAgeMs`, unless the provider requires its headers to be respected, in which case it is revalidated each
 * time. A per-source `maxAgeMs` only ever shortens the result.
 */
export function freshnessOf(
  headers: CacheHeaders,
  nowMs: number,
  options: { respectCacheHeaders: boolean; policy?: SourceCachePolicy; heuristicMaxAgeMs?: number },
): Freshness {
  const parsed = directives(headers.cacheControl);
  const storable = !parsed.has('no-store');
  const fromHeaders = headerMaxAgeMs(headers, nowMs);
  let maxAgeMs =
    fromHeaders ?? (options.respectCacheHeaders ? 0 : (options.heuristicMaxAgeMs ?? DEFAULT_HEURISTIC_MAX_AGE_MS));
  const override = options.policy?.maxAgeMs;
  if (override !== undefined && override >= 0 && override < maxAgeMs) maxAgeMs = override;
  return { storable, freshUntilMs: nowMs + maxAgeMs };
}

/** Reads the cache-relevant headers of a `Headers` object. */
export function cacheHeadersOf(headers: Headers): CacheHeaders {
  return {
    cacheControl: headers.get('Cache-Control'),
    expires: headers.get('Expires'),
    date: headers.get('Date'),
    etag: headers.get('ETag'),
    lastModified: headers.get('Last-Modified'),
  };
}
