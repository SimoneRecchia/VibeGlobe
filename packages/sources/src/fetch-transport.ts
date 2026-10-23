import type { AbortHandle, TileRequest, TileTransport, TimeoutsMs, TransportResult } from '@vibeglobe/core';
import { expectTiming, takeTiming } from './resource-timing.js';

/** Reads a Retry-After header (seconds or an HTTP date) as milliseconds from now. */
export function retryAfterMs(header: string | null, nowMs: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}

/**
 * Credentials of one source (F252): headers sent only to the listed origins, and a callback that renews them when a
 * server answers 401 or 403 (the request is then tried once more).
 */
export interface SourceAuth {
  /** Origins (`https://tiles.example.com`) that receive the credentials; requests elsewhere carry none. */
  readonly origins: readonly string[];
  /** The current credentials as headers, for example `{ Authorization: 'Bearer …' }`. */
  headers(): Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
  /** Renews expired credentials; called once per refused request, never twice at the same time. */
  refresh?(): Promise<void>;
}

/** What {@link fetchTransport} adds to every request beyond the URL the engine sees. */
export interface FetchTransportExtras {
  /** Per-source credentials (F252). */
  readonly auth?: SourceAuth;
  /**
   * Query parameters a provider requires in the URL (an API key): appended only when the request is made, so the
   * engine, its logs, traces and the debug overlay never see them (F253).
   */
  readonly secretQuery?: () => Readonly<Record<string, string>>;
  /** The fetch credentials mode (cookies and HTTP authentication) of the source's requests (F251); `omit` by default. */
  readonly credentials?: RequestCredentials;
}

/** Names of query parameters whose values are secrets (keys, tokens, signatures, session ids). */
const SECRET_PARAMETER = /key|token|secret|signature|sig$|password|auth|session|credential/i;

/** A URL with the values of its secret-looking query parameters replaced by `***`, for logs and errors (F253). */
export function redactUrl(url: string): string {
  return url.replace(/([?&])([^=&#]+)=([^&#]*)/g, (match: string, sep: string, name: string) =>
    SECRET_PARAMETER.test(decodeURIComponent(name)) ? `${sep}${name}=***` : match,
  );
}

const originOf = (url: string): string | undefined => {
  try {
    return new URL(url, globalThis.location?.href).origin;
  } catch {
    return undefined;
  }
};

/**
 * A tile transport over `fetch` with `AbortController`: a request ends with its bytes, an HTTP status, a network
 * error, a timeout (first byte or whole body, F092) or an abort (F090). `fetchImpl` is injectable for tests;
 * `headers` are sent with every request (a quantized-mesh `Accept` header naming its extensions, F128). A request
 * that fails as a network error is checked once without CORS: when the server answers that way, the failure is
 * reported as CORS (F251), which the engine logs with its cause instead of retrying. `extras` adds credentials and
 * secret query parameters (F252, F253).
 */
export function fetchTransport(
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  headers?: Readonly<Record<string, string>>,
  extras: FetchTransportExtras = {},
): TileTransport {
  const credentials = new Credentials(extras);
  return {
    start(request: TileRequest, timeouts: TimeoutsMs, done: (result: TransportResult) => void): AbortHandle {
      const controller = new AbortController();
      let settled = false;
      let reason: 'aborted' | 'timeout' = 'aborted';
      const finish = (result: TransportResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(firstByte);
        clearTimeout(total);
        if (timed) takeTiming(url);
        done(result);
      };
      const expire = (): void => {
        reason = 'timeout';
        controller.abort();
      };
      const firstByte = setTimeout(expire, timeouts.firstByteMs);
      const total = setTimeout(expire, timeouts.totalMs);
      const url = credentials.withSecrets(request.url);
      const startMs = performance.now();
      const timed = expectTiming(url);
      const attempt = async (renewed: boolean): Promise<void> => {
        const pending = credentials.headersFor(url);
        const auth = pending instanceof Promise ? await pending : pending;
        if (controller.signal.aborted) throw new DOMException('aborted', 'AbortError');
        const merged = headers || auth ? { ...headers, ...auth } : undefined;
        const response = await fetchImpl(url, {
          signal: controller.signal,
          mode: 'cors',
          credentials: extras.credentials ?? 'omit',
          ...(merged ? { headers: merged } : {}),
        });
        clearTimeout(firstByte);
        if ((response.status === 401 || response.status === 403) && auth && !renewed && (await credentials.renew())) {
          await attempt(true);
          return;
        }
        finish(await resultOf(response, performance.now() - startMs, timed ? url : undefined));
      };
      attempt(false).catch(async () => {
        if (controller.signal.aborted) return finish({ kind: reason });
        finish(
          (await answersWithoutCors(fetchImpl, url, controller.signal))
            ? { kind: 'network-error', cause: 'cors' }
            : { kind: 'network-error' },
        );
      });
      return () => {
        if (!settled) controller.abort();
      };
    },
  };
}

/**
 * The transport result of a response (its headers after `waitMs`): its bytes, or its status. With `timedUrl`, the
 * network timings of the response replace the main thread's once their entry arrives, a task later (F300).
 */
async function resultOf(response: Response, waitMs: number, timedUrl?: string): Promise<TransportResult> {
  if (!response.ok)
    return {
      kind: 'status',
      status: response.status,
      retryAfterMs: retryAfterMs(response.headers.get('Retry-After'), Date.now()),
    };
  const bytes = await response.arrayBuffer();
  const maxAgeMs = maxAgeOf(response.headers, Date.now());
  if (timedUrl !== undefined) await new Promise((resolve) => setTimeout(resolve, 0));
  const timing = timedUrl === undefined ? undefined : takeTiming(timedUrl);
  return {
    kind: 'ok',
    bytes,
    contentType: response.headers.get('Content-Type') ?? '',
    ...(maxAgeMs === undefined ? {} : { maxAgeMs }),
    ...(timing
      ? { waitMs: timing.waitMs, transferMs: timing.transferMs, endAgoMs: timing.endAgoMs, cached: timing.cached }
      : { waitMs }),
  };
}

/**
 * How long a response may be reused (F260): none with `no-store` or `no-cache`, `max-age`, else `Expires` less the
 * response's `Date` (or now); undefined without cache headers.
 */
export function maxAgeOf(headers: Headers, nowMs: number): number | undefined {
  const control = (headers.get('Cache-Control') ?? '').toLowerCase();
  if (/(^|[,\s])(no-store|no-cache)($|[,\s=])/.test(control)) return 0;
  const maxAge = /(^|[,\s])max-age\s*=\s*"?(\d+)/.exec(control)?.[2];
  if (maxAge !== undefined) return Number(maxAge) * 1000;
  const expires = headers.get('Expires');
  if (expires === null) return undefined;
  // An invalid date, such as the common `Expires: 0`, means already expired (RFC 9111 §5.3).
  const expiresMs = /[a-z]/i.test(expires) ? Date.parse(expires) : NaN;
  if (Number.isNaN(expiresMs)) return 0;
  const dateMs = Date.parse(headers.get('Date') ?? '');
  return Math.max(0, expiresMs - (Number.isNaN(dateMs) ? nowMs : dateMs));
}

/** A source's credentials and secret query parameters (F252, F253). */
class Credentials {
  private refreshing: Promise<void> | undefined;

  constructor(private readonly extras: FetchTransportExtras) {}

  /** The credential headers for a URL: only for the source's own origins (none, at once, without credentials). */
  headersFor(url: string): Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>> | undefined {
    const auth = this.extras.auth;
    if (!auth) return undefined;
    const origin = originOf(url);
    return auth && origin !== undefined && auth.origins.includes(origin) ? auth.headers() : undefined;
  }

  /** Renews refused credentials, one renewal at a time; false when the source cannot renew them. */
  async renew(): Promise<boolean> {
    const refresh = this.extras.auth?.refresh;
    if (!refresh) return false;
    this.refreshing ??= refresh().finally(() => (this.refreshing = undefined));
    await this.refreshing;
    return true;
  }

  /** The URL with the secret query parameters, added only when the request is made. */
  withSecrets(url: string): string {
    const query = this.extras.secretQuery?.();
    if (!query || Object.keys(query).length === 0) return url;
    return `${url}${url.includes('?') ? '&' : '?'}${new URLSearchParams(query).toString()}`;
  }
}

/**
 * True when a cross-origin URL that failed with CORS answers a request that does not ask for CORS: the server is
 * there, but sends no `Access-Control-Allow-Origin` (F251).
 */
async function answersWithoutCors(fetchImpl: typeof fetch, url: string, signal: AbortSignal): Promise<boolean> {
  const origin = originOf(url);
  if (origin === undefined || origin === globalThis.location?.origin) return false;
  try {
    const response = await fetchImpl(url, { signal, mode: 'no-cors', credentials: 'omit' });
    return response.type === 'opaque';
  } catch {
    return false;
  }
}
