import { WEB_MERCATOR_TILING, type TileCoord, type TileRequest } from '@vibeglobe/core';
import { archiveTransport, HttpStatusError, NetworkError, readBody } from '../archive-transport.js';
import { retryAfterMs } from '../fetch-transport.js';
import { type Attribution, type DescribedImagerySource, type ProviderProfile, SourceConfigError } from '../metadata.js';

/** The terms that apply: the customer's billing account address in the European Economic Area, or elsewhere. */
export type GoogleBillingRegion = 'eea' | 'other';

/** The Google profile with the settings ADR 0031 maps from Google's terms. */
export interface GoogleProfile extends ProviderProfile {
  readonly billingRegion: GoogleBillingRegion;
  /** Tiles may be drawn, never exported or analyzed. */
  readonly displayOnly: true;
  /** Google IDs the terms of the billing region allow storing. */
  readonly storableIds: readonly ('placeId' | 'panoId')[];
  /** The terms that apply. */
  readonly termsUrl: string;
}

const GOOGLE_TERMS = 'https://cloud.google.com/maps-platform/terms';
const GOOGLE_EEA_TERMS = 'https://cloud.google.com/terms/maps-platform/eea';
/** Renew a session this long before Google's `expiry` (ADR 0031). */
const RENEW_BEFORE_MS = 60_000;

/** The Google profile for a billing region (ADR 0031); a missing region is a configuration error, never a default. */
export function googleProfile(billingRegion: GoogleBillingRegion | undefined, logoUrl?: string): GoogleProfile {
  if (billingRegion !== 'eea' && billingRegion !== 'other')
    throw new SourceConfigError(
      'missing-billing-region',
      "Google source: set billingRegion to 'eea' (billing address in the European Economic Area) or 'other'; " +
        'the terms differ and there is no default (ADR 0031)',
    );
  return Object.freeze({
    id: 'google',
    billingRegion,
    forbids: new Set(['persistentCache', 'prefetch', 'offlinePackaging'] as const),
    respectCacheHeaders: true,
    displayOnly: true,
    requiredAttribution: logoUrl ? { text: 'Google', logo: { src: logoUrl, alt: 'Google' } } : { text: 'Google' },
    storableIds: billingRegion === 'eea' ? (['placeId', 'panoId'] as const) : (['placeId'] as const),
    termsUrl: billingRegion === 'eea' ? GOOGLE_EEA_TERMS : GOOGLE_TERMS,
    termsAdr: 'docs/adr/0031-google-maps-platform-terms.md',
  });
}

/** What every Google source needs. */
export interface GoogleSourceOptions {
  /** The customer's own Map Tiles API key (restricted to their referrers). */
  readonly apiKey: string;
  readonly billingRegion: GoogleBillingRegion;
  /** BCP 47 language of labels and copyrights (default `en-US`). */
  readonly language?: string;
  /** CLDR region of borders and labels (default `US`). */
  readonly region?: string;
  /** The application's copy of the Google logo (Google's brand resources). */
  readonly logoUrl?: string;
  /** The Map Tiles API root (default `https://tile.googleapis.com/`); fixtures point it elsewhere. */
  readonly baseUrl?: string;
  /** The `fetch` of every request; the global one by default. */
  readonly fetch?: typeof fetch;
}

/** A created session. */
interface Session {
  readonly token: string;
  readonly expiresAtMs: number;
  readonly tileWidth: number;
}

/** Creates sessions on demand, shares the one in flight, and renews it before it expires or after a refusal. */
export class GoogleSession {
  private current: Promise<Session> | undefined;
  /** Sessions requested so far. */
  created = 0;
  private readonly fetchImpl: typeof fetch;
  readonly base: string;

  constructor(
    private readonly options: GoogleSourceOptions,
    private readonly request: Readonly<Record<string, unknown>>,
  ) {
    if (!options.apiKey) throw new SourceConfigError('missing-api-key', 'Google source: apiKey is required');
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.base = (options.baseUrl ?? 'https://tile.googleapis.com/').replace(/\/?$/, '/');
  }

  /** The session token, created or renewed when needed; concurrent callers share one renewal. */
  async token(): Promise<string> {
    for (;;) {
      const pending = this.current ?? this.renew();
      const session = await pending;
      if (Date.now() < session.expiresAtMs - RENEW_BEFORE_MS) return session.token;
      if (this.current === pending) this.renew();
    }
  }

  /** Forgets the session and creates a new one (the old one expired or was refused). */
  renew(): Promise<Session> {
    const created = this.create();
    this.current = created;
    created.catch(() => {
      if (this.current === created) this.current = undefined;
    });
    return created;
  }

  /**
   * Google refused `token`: renews the session, unless a request that saw the same refusal already did, so a burst of
   * refused tiles creates one new session.
   */
  async refused(token: string): Promise<void> {
    const pending = this.current;
    const session = await pending?.catch(() => undefined);
    if (this.current === pending && (!session || session.token === token)) this.renew();
    await this.current;
  }

  /** `url` with a session token and the key, which only the adapter's own requests carry (ADR 0031). */
  withToken(url: string, token: string): string {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}session=${encodeURIComponent(token)}&key=${encodeURIComponent(this.options.apiKey)}`;
  }

  /** `url` with the current session token and the key. */
  async signed(url: string): Promise<string> {
    return this.withToken(url, await this.token());
  }

  /** Fetches with the adapter's `fetch`, turning failures into the errors `archiveTransport` maps. */
  async get(url: string, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { mode: 'cors', credentials: 'omit', ...init });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new NetworkError(error);
    }
    return response;
  }

  private async create(): Promise<Session> {
    this.created++;
    const body = JSON.stringify({
      language: this.options.language ?? 'en-US',
      region: this.options.region ?? 'US',
      ...this.request,
    });
    const response = await this.get(`${this.base}v1/createSession?key=${encodeURIComponent(this.options.apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (!response.ok)
      throw new HttpStatusError(response.status, retryAfterMs(response.headers.get('Retry-After'), Date.now()));
    const json = (await response.json()) as { session?: unknown; expiry?: unknown; tileWidth?: unknown };
    const expiry = Number(json.expiry);
    if (typeof json.session !== 'string' || !Number.isFinite(expiry))
      throw new Error('createSession answered without a session');
    return { token: json.session, expiresAtMs: expiry * 1000, tileWidth: Number(json.tileWidth) || 256 };
  }
}

/** Options of {@link googleImagery}. */
export interface GoogleImageryOptions extends GoogleSourceOptions {
  /** Unique per engine instance. */
  readonly id: string;
  readonly mapType: 'roadmap' | 'satellite' | 'terrain';
  /** Extra layers (`layerRoadmap`, `layerStreetview`, `layerTraffic`), for `terrain` and `satellite`. */
  readonly layerTypes?: readonly string[];
  /** 2 asks for high-DPI tiles. */
  readonly pixelRatio?: 1 | 2;
  readonly maxLevel?: number;
}

/** A view for {@link GoogleImagerySource.viewportCopyright}, in degrees and Web Mercator zoom. */
export interface GoogleViewport {
  readonly zoom: number;
  readonly westDeg: number;
  readonly southDeg: number;
  readonly eastDeg: number;
  readonly northDeg: number;
}

/** A Google 2D imagery source, with the copyrights of a viewport. */
export interface GoogleImagerySource extends DescribedImagerySource {
  readonly profile: GoogleProfile;
  /**
   * The copyright line Google returns for a settled view (F258): asked once per distinct view, so calling it on every
   * frame repeats no request.
   */
  viewportCopyright(view: GoogleViewport): Promise<string>;
  /** Sessions created so far (diagnostics and tests). */
  readonly sessionsCreated: () => number;
}

/** Reads one tile through the session, renewing the session once when Google refuses it (401 or 403). */
function tileReader(session: GoogleSession): Parameters<typeof archiveTransport>[0] {
  return async (url, signal) => {
    for (let attempt = 0; ; attempt++) {
      const token = await session.token();
      const response = await session.get(session.withToken(url, token), { signal });
      if (response.ok)
        return { bytes: await readBody(response, signal), contentType: response.headers.get('Content-Type') ?? '' };
      if (response.status === 404) return undefined;
      if ((response.status === 401 || response.status === 403) && attempt === 0) {
        await session.refused(token);
        continue;
      }
      throw new HttpStatusError(response.status, retryAfterMs(response.headers.get('Retry-After'), Date.now()));
    }
  };
}

/**
 * Google Maps Platform 2D tiles (F257) through the Map Tiles API with the customer's own key: a session is created with
 * the map type, language and region, renewed before it expires and whenever Google refuses it, and tile requests carry
 * its token. The engine sees URLs without the key or the session (ADR 0031). Resolves once the first session exists.
 */
export async function googleImagery(options: GoogleImageryOptions): Promise<GoogleImagerySource> {
  const profile = googleProfile(options.billingRegion, options.logoUrl);
  const session = new GoogleSession(options, {
    mapType: options.mapType,
    ...(options.layerTypes ? { layerTypes: options.layerTypes } : {}),
    ...(options.pixelRatio === 2 ? { scale: 'scaleFactor2x', highDpi: true } : {}),
  });
  try {
    await session.token();
  } catch (error) {
    throw new SourceConfigError(
      'session-refused',
      `Google source '${options.id}': cannot create a session (${String(error)})`,
    );
  }
  const copyrights = new Map<string, Promise<string>>();
  const attribution: Attribution[] = [profile.requiredAttribution ?? { text: 'Google' }];
  return {
    id: options.id,
    tiling: WEB_MERCATOR_TILING,
    minLevel: 0,
    maxLevel: options.maxLevel ?? 22,
    tileSizePx: 256,
    pixelRatio: options.pixelRatio ?? 1,
    decoder: 'image',
    transport: archiveTransport(tileReader(session)),
    attribution,
    profile,
    sessionsCreated: () => session.created,
    request(coord: TileCoord, out: TileRequest): TileRequest | 'noData' {
      if (coord.level > (options.maxLevel ?? 22)) return 'noData';
      out.url = `${session.base}v1/2dtiles/${coord.level}/${coord.x}/${coord.y}`;
      out.hostIndex = 0;
      return out;
    },
    viewportCopyright(view) {
      const z = Math.max(0, Math.round(view.zoom));
      const key = `zoom=${z}&north=${view.northDeg.toFixed(6)}&south=${view.southDeg.toFixed(6)}&east=${view.eastDeg.toFixed(6)}&west=${view.westDeg.toFixed(6)}`;
      let pending = copyrights.get(key);
      if (!pending) {
        pending = session
          .signed(`${session.base}tile/v1/viewport?${key}`)
          .then((url) => session.get(url))
          .then(async (response) =>
            response.ok ? String(((await response.json()) as { copyright?: unknown }).copyright ?? '') : '',
          )
          .catch(() => '');
        copyrights.clear();
        copyrights.set(key, pending);
      }
      return pending;
    },
  };
}
