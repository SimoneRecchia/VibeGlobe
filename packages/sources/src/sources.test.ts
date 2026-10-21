import { describe, expect, it, vi } from 'vitest';
import type { TileRequest, TransportResult } from '@vibeglobe/core';
import { fetchTransport, retryAfterMs } from './fetch-transport.js';
import { xyzImagery } from './xyz-imagery.js';

const DEG = Math.PI / 180;
const request = (): TileRequest => ({ url: '', hostIndex: 0 });
const never = fetchTransport(() => new Promise<Response>(() => undefined));

describe('xyzImagery', () => {
  it('fills XYZ and TMS templates and spreads tiles over subdomains', () => {
    const source = xyzImagery({
      id: 'osm',
      url: 'https://{s}.tiles.test/{z}/{x}/{y}.png?tms={-y}',
      subdomains: ['a', 'b', 'c'],
      transport: never,
    });
    // (5 + 2) mod 3 = 1: the second host.
    expect(source.request({ root: 0, level: 3, x: 5, y: 2 }, request())).toEqual({
      url: 'https://b.tiles.test/3/5/2.png?tms=5',
      hostIndex: 1,
    });
    expect(source.tiling.crs).toBe('EPSG:3857');
    expect(xyzImagery({ id: 'g', url: '{z}/{x}/{y}', tiling: 'geographic', transport: never }).tiling.rootTilesX).toBe(
      2,
    );
  });

  it('reports no data outside its levels and its coverage, so those tiles are never requested (F093, F094)', () => {
    const source = xyzImagery({
      id: 'italy',
      url: '/{z}/{x}/{y}.png',
      minLevel: 2,
      maxLevel: 12,
      coverage: [{ westRad: 6 * DEG, southRad: 36 * DEG, eastRad: 19 * DEG, northRad: 47.5 * DEG }],
      transport: never,
    });
    expect(source.request({ root: 0, level: 1, x: 1, y: 0 }, request())).toBe('noData');
    expect(source.request({ root: 0, level: 13, x: 4365, y: 2925 }, request())).toBe('noData');
    // Level 6: Rome is in tile (34, 23); New York (18, 24) is outside the coverage.
    expect(source.request({ root: 0, level: 6, x: 34, y: 23 }, request())).not.toBe('noData');
    expect(source.request({ root: 0, level: 6, x: 18, y: 24 }, request())).toBe('noData');
  });
});

describe('fetchTransport', () => {
  const timeouts = { firstByteMs: 1000, totalMs: 5000 };
  const run = (fake: typeof fetch): Promise<TransportResult> =>
    new Promise((resolve) => fetchTransport(fake).start({ url: '/t.png', hostIndex: 0 }, timeouts, resolve));

  it('returns the bytes and content type of a successful response', async () => {
    const result = await run(() =>
      Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } })),
    );
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect([result.bytes.byteLength, result.contentType]).toEqual([3, 'image/png']);
  });

  it('reports HTTP statuses with Retry-After, and network errors', async () => {
    expect(
      await run(() => Promise.resolve(new Response(null, { status: 503, headers: { 'Retry-After': '2' } }))),
    ).toEqual({
      kind: 'status',
      status: 503,
      retryAfterMs: 2000,
    });
    expect(await run(() => Promise.reject(new TypeError('offline')))).toEqual({ kind: 'network-error' });
    expect(retryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT', Date.parse('Wed, 21 Oct 2026 07:27:00 GMT'))).toBe(60000);
    expect(retryAfterMs('soon', 0)).toBeUndefined();
  });

  it('times out a request that never answers and reports an abort as aborted (F090, F092)', async () => {
    vi.useFakeTimers();
    try {
      const hanging: typeof fetch = (_input, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
        );
      const results: TransportResult[] = [];
      fetchTransport(hanging).start({ url: '/a', hostIndex: 0 }, timeouts, (r) => results.push(r));
      const abort = fetchTransport(hanging).start({ url: '/b', hostIndex: 0 }, timeouts, (r) => results.push(r));
      abort();
      await vi.advanceTimersByTimeAsync(1001);
      expect(results).toEqual([{ kind: 'aborted' }, { kind: 'timeout' }]);
      // Aborting after the end does nothing.
      abort();
      expect(results).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
