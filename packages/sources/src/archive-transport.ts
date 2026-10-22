import type { AbortHandle, TileRequest, TileTransport, TimeoutsMs, TransportResult } from '@vibeglobe/core';
import { retryAfterMs } from './fetch-transport.js';

/** An HTTP answer that is not a success, raised by the readers behind {@link archiveTransport}. */
export class HttpStatusError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;

  constructor(status: number, retryAfter: number | undefined) {
    super(`HTTP ${status}`);
    this.name = 'HttpStatusError';
    this.status = status;
    this.retryAfterMs = retryAfter;
  }
}

/** A request that never got an answer (DNS, connection, CORS), raised by the readers behind {@link archiveTransport}. */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super(`network error: ${String(cause)}`);
    this.name = 'NetworkError';
  }
}

/** One tile read by an archive or a session-based service, or undefined when it does not exist. */
export type TileReader = (
  url: string,
  signal: AbortSignal,
) => Promise<{ bytes: ArrayBuffer; contentType: string } | undefined>;

/**
 * Fetches a range of bytes with `fetchImpl`, raising {@link HttpStatusError} and {@link NetworkError} so that the
 * transport reports them as the frozen contract requires. A server that ignores the range answers 200 with the whole
 * file, which still works.
 */
export async function fetchRange(
  fetchImpl: typeof fetch,
  url: string,
  offset: number,
  length: number,
  init: RequestInit,
): Promise<ArrayBuffer> {
  let response: Response;
  try {
    const headers = new Headers(init.headers);
    headers.set('Range', `bytes=${offset}-${offset + length - 1}`);
    response = await fetchImpl(url, { ...init, headers });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new NetworkError(error);
  }
  if (response.status !== 206 && response.status !== 200)
    throw new HttpStatusError(response.status, retryAfterMs(response.headers.get('Retry-After'), Date.now()));
  const bytes = await readBody(response, init.signal);
  return response.status === 200 ? bytes.slice(offset, offset + length) : bytes;
}

/**
 * The body of `response`, raising {@link NetworkError} when the connection drops while it is read, so the transport
 * reports a retryable network error instead of a tile without data.
 */
export async function readBody(response: Response, signal: AbortSignal | null | undefined): Promise<ArrayBuffer> {
  try {
    return await response.arrayBuffer();
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new NetworkError(error);
  }
}

function resultOf(error: unknown, reason: 'aborted' | 'timeout', aborted: boolean): TransportResult {
  if (aborted) return { kind: reason };
  if (error instanceof HttpStatusError)
    return { kind: 'status', status: error.status, retryAfterMs: error.retryAfterMs };
  if (error instanceof NetworkError) return { kind: 'network-error' };
  // Anything else is a malformed archive or answer: the tile is treated as no data, never as a crash.
  return { kind: 'ok', bytes: new ArrayBuffer(0), contentType: '' };
}

/**
 * A transport over an asynchronous tile reader (an archive, a database, a session-based service): timeouts, aborts
 * and errors become the results of the frozen contract; a missing tile becomes a 404; it never throws.
 */
export function archiveTransport(read: TileReader): TileTransport {
  return {
    start(request: TileRequest, timeouts: TimeoutsMs, done: (result: TransportResult) => void): AbortHandle {
      const controller = new AbortController();
      let settled = false;
      let reason: 'aborted' | 'timeout' = 'aborted';
      const finish = (result: TransportResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        done(result);
      };
      const timer = setTimeout(() => {
        reason = 'timeout';
        controller.abort();
        finish({ kind: 'timeout' });
      }, timeouts.totalMs);
      let reading: ReturnType<TileReader>;
      try {
        reading = read(request.url, controller.signal);
      } catch (error) {
        // A reader that fails before its first await (a synchronous database read) still never throws from here.
        reading = Promise.reject(error);
      }
      reading
        .then((tile) =>
          finish(
            tile === undefined
              ? { kind: 'status', status: 404, retryAfterMs: undefined }
              : { kind: 'ok', bytes: tile.bytes, contentType: tile.contentType },
          ),
        )
        .catch((error: unknown) => finish(resultOf(error, reason, controller.signal.aborted)));
      return () => {
        if (settled) return;
        controller.abort();
        finish({ kind: 'aborted' });
      };
    },
  };
}

/** Parses the `z/x/y` at the end of a tile URL (after `#` or the last path segments). */
export function tileOfUrl(url: string): { z: number; x: number; y: number } | undefined {
  const match = /(\d+)\/(\d+)\/(\d+)$/.exec(url);
  if (!match) return undefined;
  return { z: Number(match[1]), x: Number(match[2]), y: Number(match[3]) };
}
