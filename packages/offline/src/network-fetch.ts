// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { TimeoutsMs } from '@vibeglobe/core';
import { expectTiming, retryAfterMs, takeTiming, type NetworkTiming } from '@vibeglobe/sources';
import { cacheHeadersOf, type CacheHeaders } from './cache-policy.js';

/** How one network request ended, with what the cache needs to know. */
export type FetchOutcome =
  | {
      readonly kind: 'ok';
      readonly bytes: ArrayBuffer;
      readonly contentType: string;
      readonly headers: CacheHeaders;
      /** The response's network timings, when the browser reports them (F300). */
      readonly timing?: NetworkTiming;
    }
  | { readonly kind: 'not-modified'; readonly headers: CacheHeaders }
  | { readonly kind: 'status'; readonly status: number; readonly retryAfterMs: number | undefined }
  /** A redirect or an HTML page where a tile was expected: a captive portal or a misconfigured endpoint (F297). */
  | { readonly kind: 'portal' }
  | { readonly kind: 'network-error' | 'timeout' | 'aborted' };

/** Validators sent to revalidate a stored tile (F278). */
export interface Validators {
  readonly etag?: string;
  readonly lastModified?: string;
}

/**
 * True for an answer that is a captive portal's login page instead of tile data: a redirect, or an HTML page served as
 * a success. An HTML error page (a 404 from a web server) is a real answer from the endpoint.
 */
export function looksLikePortal(response: Response): boolean {
  if (response.redirected || response.type === 'opaqueredirect') return true;
  const type = (response.headers.get('Content-Type') ?? '').toLowerCase();
  return response.ok && type.startsWith('text/html');
}

async function outcomeOf(response: Response, timedUrl: string | undefined): Promise<FetchOutcome> {
  const headers = cacheHeadersOf(response.headers);
  if (response.status === 304) return { kind: 'not-modified', headers };
  if (looksLikePortal(response)) return { kind: 'portal' };
  if (!response.ok)
    return {
      kind: 'status',
      status: response.status,
      retryAfterMs: retryAfterMs(response.headers.get('Retry-After'), Date.now()),
    };
  const bytes = await response.arrayBuffer();
  const contentType = response.headers.get('Content-Type') ?? '';
  if (timedUrl === undefined) return { kind: 'ok', bytes, contentType, headers };
  // The timing entry arrives a task after the body (F300).
  await new Promise((resolve) => setTimeout(resolve, 0));
  const timing = takeTiming(timedUrl);
  return timing ? { kind: 'ok', bytes, contentType, headers, timing } : { kind: 'ok', bytes, contentType, headers };
}

/**
 * Fetches one tile with time limits (to the headers and in all), revalidating with If-None-Match and If-Modified-Since
 * when validators are given. Never throws. `signal` aborts it.
 */
export async function fetchTile(
  fetchImpl: typeof fetch,
  url: string,
  timeouts: TimeoutsMs,
  signal: AbortSignal,
  validators?: Validators,
): Promise<FetchOutcome> {
  const controller = new AbortController();
  let reason: 'aborted' | 'timeout' = 'aborted';
  const expire = (): void => {
    reason = 'timeout';
    controller.abort();
  };
  const onAbort = (): void => controller.abort();
  signal.addEventListener('abort', onAbort);
  const firstByte = setTimeout(expire, timeouts.firstByteMs);
  const total = setTimeout(expire, timeouts.totalMs);
  const headers = new Headers();
  if (validators?.etag) headers.set('If-None-Match', validators.etag);
  if (validators?.lastModified) headers.set('If-Modified-Since', validators.lastModified);
  const timed = expectTiming(url);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      mode: 'cors',
      credentials: 'omit',
      headers,
      // The engine keeps its own cache: the HTTP cache would hide revalidations and serve stale tiles twice.
      cache: 'no-store',
    });
    clearTimeout(firstByte);
    return await outcomeOf(response, timed ? url : undefined);
  } catch {
    return { kind: controller.signal.aborted ? reason : 'network-error' };
  } finally {
    clearTimeout(firstByte);
    clearTimeout(total);
    signal.removeEventListener('abort', onAbort);
    if (timed) takeTiming(url);
  }
}
