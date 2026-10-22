import type { TileTransport } from '@vibeglobe/core';
import { fetchTransport } from '../fetch-transport.js';
import { type DescribedImagerySource, type ProviderProfile, SourceConfigError } from '../metadata.js';
import { xyzImagery } from '../xyz-imagery.js';

/** At most this many requests in flight to the public servers (ADR 0032). */
export const OSM_PUBLIC_MAX_CONCURRENT = 2;

/** The OpenStreetMap public-servers profile, mapped from the OSMF tile usage policy in ADR 0032. */
export const OSM_PUBLIC_PROFILE: ProviderProfile = Object.freeze({
  id: 'osm-public',
  forbids: new Set(['prefetch', 'offlinePackaging', 'persistentCache'] as const),
  respectCacheHeaders: true,
  maxConcurrentRequests: OSM_PUBLIC_MAX_CONCURRENT,
  requiredAttribution: { text: '© OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright' },
  termsAdr: 'docs/adr/0032-openstreetmap-tile-usage-policy.md',
});

/** Options of {@link openStreetMapImagery}. */
export interface OpenStreetMapImageryOptions {
  /** Unique per engine instance (default `osm-public`). */
  readonly id?: string;
  /** The application's name, as the usage policy requires it to identify itself. */
  readonly appName: string;
  /** The application's web address (its pages send it as `Referer`). */
  readonly appUrl: string;
  /** The tile server (default the OSMF's `https://tile.openstreetmap.org/{z}/{x}/{y}.png`); fixtures change it. */
  readonly url?: string;
  /** The `fetch` of tile requests; the global one by default. */
  readonly fetch?: typeof fetch;
  /** Receives the one warning that the public servers are not for production (default `console.warn`). */
  readonly warn?: (message: string) => void;
}

function checkIdentity(options: OpenStreetMapImageryOptions): void {
  let valid = typeof options.appName === 'string' && options.appName.trim().length > 0;
  try {
    valid &&= /^https?:$/.test(new URL(options.appUrl).protocol);
  } catch {
    valid = false;
  }
  if (!valid)
    throw new SourceConfigError(
      'missing-app-identity',
      'OpenStreetMap public servers: the tile usage policy requires the application to identify itself; set appName ' +
        'and appUrl (an http or https address) (ADR 0032)',
    );
}

/**
 * The transport of the public servers: the browser sends the page's origin as `Referer` (the referrer policy never
 * strips it), the HTTP cache follows the servers' headers, and no no-cache header is ever sent. Outside browsers, where
 * there is no `Referer`, a `User-Agent` names the application.
 */
function identifiedTransport(options: OpenStreetMapImageryOptions): TileTransport {
  const base = options.fetch ?? ((input, init) => fetch(input, init));
  const headers: Record<string, string> =
    typeof document === 'undefined' ? { 'User-Agent': `${options.appName} (${options.appUrl})` } : {};
  return fetchTransport((input, init) =>
    base(input, { ...init, referrerPolicy: 'strict-origin-when-cross-origin', cache: 'default', headers }),
  );
}

/**
 * Raster tiles from the OpenStreetMap Foundation's public servers (F264–F267) under their usage policy (ADR 0032):
 * light use only, at most two requests in flight, the application identified on every request, attribution to
 * OpenStreetMap contributors, and no prefetch or offline packaging. The public servers are unsuitable for production
 * products, so creating the source warns once; products use self-hosted tiles from the data pipeline.
 */
export function openStreetMapImagery(options: OpenStreetMapImageryOptions): DescribedImagerySource {
  checkIdentity(options);
  (options.warn ?? ((message: string) => console.warn(message)))(
    '[vibeglobe] The OpenStreetMap public tile servers are for light use only and unsuitable for production products; ' +
      'serve tiles built by the data pipeline instead (docs/guides/sources.md).',
  );
  const source = xyzImagery({
    id: options.id ?? 'osm-public',
    url: options.url ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxLevel: 19,
    maxRequestsPerHost: OSM_PUBLIC_MAX_CONCURRENT,
    transport: identifiedTransport(options),
  });
  return {
    ...source,
    attribution: [OSM_PUBLIC_PROFILE.requiredAttribution ?? { text: '' }],
    profile: OSM_PUBLIC_PROFILE,
  };
}
