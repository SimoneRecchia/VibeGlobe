import type { AbortHandle, TileRequest, TileTransport, TimeoutsMs, TransportResult } from '@vibeglobe/core';

/** Reads a Retry-After header (seconds or an HTTP date) as milliseconds from now. */
export function retryAfterMs(header: string | null, nowMs: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}

/**
 * A tile transport over `fetch` with `AbortController`: a request ends with its bytes, an HTTP status, a network
 * error, a timeout (first byte or whole body, F092) or an abort (F090). `fetchImpl` is injectable for tests;
 * `headers` are sent with every request (a quantized-mesh `Accept` header naming its extensions, F128).
 */
export function fetchTransport(
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  headers?: Readonly<Record<string, string>>,
): TileTransport {
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
        done(result);
      };
      const expire = (): void => {
        reason = 'timeout';
        controller.abort();
      };
      const firstByte = setTimeout(expire, timeouts.firstByteMs);
      const total = setTimeout(expire, timeouts.totalMs);
      fetchImpl(request.url, {
        signal: controller.signal,
        mode: 'cors',
        credentials: 'omit',
        ...(headers ? { headers } : {}),
      })
        .then(async (response) => {
          clearTimeout(firstByte);
          if (!response.ok) {
            finish({
              kind: 'status',
              status: response.status,
              retryAfterMs: retryAfterMs(response.headers.get('Retry-After'), Date.now()),
            });
            return;
          }
          const bytes = await response.arrayBuffer();
          finish({ kind: 'ok', bytes, contentType: response.headers.get('Content-Type') ?? '' });
        })
        .catch(() => finish({ kind: controller.signal.aborted ? reason : 'network-error' }));
      return () => {
        if (!settled) controller.abort();
      };
    },
  };
}
