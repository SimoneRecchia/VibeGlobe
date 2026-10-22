import type { ImagerySource, TileCoord, TransportResult } from '@vibeglobe/core';
import { xyzImagery } from '@vibeglobe/sources';
import { afterEach, describe, expect, it } from 'vitest';
import { freshnessOf } from './cache-policy.js';
import { memoryStore } from './memory-store.js';
import { createOffline, type Offline, type OfflineOptions } from './offline-engine.js';

interface Served {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  redirected?: boolean;
}

/** A fake network: answers by URL, records every request with its revalidation header. */
function fakeNetwork(answer: (url: string) => Served | 'down') {
  const requests: { url: string; ifNoneMatch: string | null }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, ifNoneMatch: new Headers(init?.headers).get('If-None-Match') });
    const served = answer(url);
    if (served === 'down') throw new TypeError('Failed to fetch');
    const response = new Response(served.status === 304 ? null : (served.body ?? 'tile'), {
      status: served.status ?? 200,
      headers: { 'Content-Type': 'image/png', ...served.headers },
    });
    if (served.redirected) Object.defineProperty(response, 'redirected', { value: true });
    return response;
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const TIMEOUTS = { firstByteMs: 1000, totalMs: 1000 };
const engines: Offline[] = [];

function engine(options: OfflineOptions): Offline {
  const created = createOffline({ store: memoryStore(), healthChecks: { minIntervalMs: 10 }, ...options });
  engines.push(created);
  return created;
}

afterEach(() => {
  for (const e of engines.splice(0)) e.destroy();
});

function load(source: ImagerySource, coord: TileCoord): Promise<TransportResult> {
  const request = source.request(coord, { url: '', hostIndex: 0 });
  if (request === 'noData' || request === 'unknown') throw new Error('no data');
  return new Promise((resolve) => source.transport.start(request, TIMEOUTS, resolve));
}

const text = (result: TransportResult): string =>
  result.kind === 'ok' ? new TextDecoder().decode(result.bytes) : result.kind;
const tile = (level: number, x: number, y: number): TileCoord => ({ root: 0, level, x, y });
const fixture = (id = 'osm') => xyzImagery({ id, url: 'https://tiles.test/{z}/{x}/{y}.png' });

describe('the offline engine', () => {
  it('defaults to hybrid with every loading feature on (F271)', () => {
    const offline = engine({});
    expect(offline.settings()).toEqual({
      mode: 'hybrid',
      switches: { persistentCache: true, memoryReuse: true, prefetch: true, offlinePackaging: true },
    });
  });

  it('serves a fresh cached tile without a request and revalidates an expired one with its ETag (F277, F278)', async () => {
    let version = 'v1';
    const net = fakeNetwork((url) =>
      url.endsWith('/1/0/0.png')
        ? { headers: { 'Cache-Control': 'max-age=3600' }, body: 'fresh' }
        : { headers: { 'Cache-Control': 'no-cache', ETag: `"${version}"` }, body: version },
    );
    const offline = engine({ fetch: net.fetchImpl });
    const source = offline.source(fixture(), { revalidation: 'conditional' });
    expect(text(await load(source, tile(1, 0, 0)))).toBe('fresh');
    expect(text(await load(source, tile(1, 0, 0)))).toBe('fresh');
    expect(net.requests.filter((r) => r.url.endsWith('/1/0/0.png'))).toHaveLength(1);
    expect(offline.stats('osm').persistent).toBe(1);

    expect(text(await load(source, tile(1, 1, 0)))).toBe('v1');
    // Unchanged on the server: a 304 reuses the stored tile.
    const unchanged = fakeNetwork(() => ({ status: 304, headers: { ETag: '"v1"', 'Cache-Control': 'no-cache' } }));
    const store = memoryStore();
    const second = engine({ fetch: unchanged.fetchImpl, store });
    const revalidating = second.source(fixture(), { revalidation: 'conditional' });
    await store.put('osm/1/1/0', {
      bytes: new TextEncoder().encode('v1').buffer,
      contentType: 'image/png',
      storedAtMs: 0,
      freshUntilMs: 0,
      etag: '"v1"',
    });
    expect(text(await load(revalidating, tile(1, 1, 0)))).toBe('v1');
    expect(unchanged.requests[0]?.ifNoneMatch).toBe('"v1"');
    expect(second.stats().revalidated).toBe(1);
    // Changed on the server: the new tile replaces the stored one.
    version = 'v2';
    expect(text(await load(source, tile(1, 1, 0)))).toBe('v2');
    expect(net.requests.at(-1)?.ifNoneMatch).toBe('"v1"');
  });

  it('never persists no-store tiles and lets overrides only shorten the header time (F277)', async () => {
    const store = memoryStore();
    const net = fakeNetwork(() => ({ headers: { 'Cache-Control': 'no-store' } }));
    const offline = engine({ fetch: net.fetchImpl, store });
    await load(offline.source(fixture()), tile(2, 1, 1));
    expect((await store.usage()).bytes).toBe(0);
    const headers = { cacheControl: 'max-age=60', expires: null, date: null, etag: null, lastModified: null };
    expect(freshnessOf(headers, 0, { respectCacheHeaders: true, policy: { maxAgeMs: 1000 } }).freshUntilMs).toBe(1000);
    expect(freshnessOf(headers, 0, { respectCacheHeaders: true, policy: { maxAgeMs: 120_000 } }).freshUntilMs).toBe(
      60_000,
    );
    const expires = { ...headers, cacheControl: null, expires: 'Thu, 01 Jan 1970 00:00:10 GMT' };
    expect(freshnessOf(expires, 0, { respectCacheHeaders: true }).freshUntilMs).toBe(10_000);
  });

  it('with the persistent cache off, globally or for one source, neither reads nor writes it (F280)', async () => {
    const store = memoryStore();
    const net = fakeNetwork(() => ({ headers: { 'Cache-Control': 'max-age=3600' } }));
    const offline = engine({ fetch: net.fetchImpl, store, switches: { persistentCache: false } });
    const a = offline.source(fixture('a'));
    await load(a, tile(1, 0, 0));
    await load(a, tile(1, 0, 0));
    expect(net.requests).toHaveLength(2);
    expect((await store.usage()).bytes).toBe(0);
    offline.setSwitches({ persistentCache: true });
    offline.setSwitches({ persistentCache: false }, { sourceId: 'a' });
    const b = offline.source(fixture('b'));
    await load(a, tile(1, 1, 1));
    await load(b, tile(1, 1, 1));
    expect(await store.get('a/1/1/1')).toBeUndefined();
    expect(await store.get('b/1/1/1')).toBeDefined();
  });

  it('a provider that forbids persistent caching is never written, whatever the switches (F318)', async () => {
    const store = memoryStore();
    const offline = engine({ fetch: fakeNetwork(() => ({})).fetchImpl, store });
    const rules = { id: 'strict', forbids: new Set(['persistentCache'] as const), respectCacheHeaders: true };
    await load(offline.source(fixture('strict'), { rules }), tile(1, 0, 0));
    await load(offline.source(fixture('open')), tile(1, 0, 0));
    expect(await store.get('strict/1/0/0')).toBeUndefined();
    expect(await store.get('open/1/0/0')).toBeDefined();
    offline.setSwitches({ persistentCache: true }, { sourceId: 'strict' });
    expect(offline.effectiveSwitches('strict').persistentCache).toBe(false);
  });

  it('offline-only mode never touches the network and online-only never reads packages (F291, F292)', async () => {
    const net = fakeNetwork(() => ({}));
    const offline = engine({ fetch: net.fetchImpl, mode: 'offline' });
    let packageReads = 0;
    offline.setPackageReader({
      read: (_id, coord) => {
        packageReads++;
        return Promise.resolve(
          coord.level === 1
            ? { bytes: new TextEncoder().encode('pkg').buffer, contentType: 'image/png', packageId: 'p' }
            : undefined,
        );
      },
    });
    const source = offline.source(fixture());
    expect(text(await load(source, tile(1, 0, 0)))).toBe('pkg');
    expect(await load(source, tile(5, 0, 0))).toEqual({ kind: 'status', status: 404, retryAfterMs: undefined });
    expect(net.requests).toHaveLength(0);
    offline.setMode('online');
    packageReads = 0;
    expect(text(await load(source, tile(1, 1, 1)))).toBe('tile');
    expect(packageReads).toBe(0);
  });

  it('detects a captive portal by health check, waits instead of retrying, and resumes when it clears (F297, F298, F299)', async () => {
    let portal = true;
    const net = fakeNetwork(() =>
      portal ? { redirected: true, headers: { 'Content-Type': 'text/html' }, body: '<html>login</html>' } : {},
    );
    const offline = engine({ fetch: net.fetchImpl });
    const changes: string[] = [];
    offline.on('connectivity-change', (event) => changes.push(event.connectivity));
    const source = offline.source(fixture());
    // The failure waits for the health check it triggered: unreachable, so the engine is asked to try again later
    // instead of counting a failure; the portal page is never a tile.
    expect((await load(source, tile(3, 1, 1))).kind).toBe('aborted');
    await expect.poll(() => offline.connectivity).toBe('offline');
    // While unreachable a miss is held, then handed back as an abort without a request.
    expect((await load(source, tile(3, 2, 2))).kind).toBe('aborted');
    expect(net.requests.filter((r) => r.url.endsWith('/3/2/2.png'))).toHaveLength(0);
    portal = false;
    await expect.poll(() => offline.connectivity, { timeout: 3000 }).toBe('online');
    expect(text(await load(source, tile(3, 2, 2)))).toBe('tile');
    expect(changes).toEqual(['offline', 'online']);
  });

  it('a failure on an endpoint the health check finds reachable goes to the engine, which backs off (F315)', async () => {
    let first = true;
    const net = fakeNetwork((url) => {
      if (url.endsWith('/4/1/1.png') && first) {
        first = false;
        return 'down';
      }
      return {};
    });
    const offline = engine({ fetch: net.fetchImpl });
    const source = offline.source(fixture());
    expect((await load(source, tile(4, 1, 1))).kind).toBe('network-error');
    expect(offline.connectivity).toBe('online');
    expect(text(await load(source, tile(4, 1, 1)))).toBe('tile');
  });

  it('marks only the dead endpoint unreachable and backs its checks off (F297)', async () => {
    const net = fakeNetwork((url) => (url.startsWith('https://dead.test') ? 'down' : {}));
    const offline = engine({ fetch: net.fetchImpl, healthChecks: { minIntervalMs: 20, maxIntervalMs: 200 } });
    const dead = offline.source(xyzImagery({ id: 'dead', url: 'https://dead.test/{z}/{x}/{y}.png' }));
    const live = offline.source(fixture());
    await load(dead, tile(2, 0, 0));
    await expect.poll(() => offline.connectivity).toBe('degraded');
    expect(text(await load(live, tile(2, 0, 0)))).toBe('tile');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const checks = net.requests.filter((r) => r.url.startsWith('https://dead.test/0/0/0')).map((r) => r.url);
    // 20, 40, 80, 160, 200 ms waits: about five checks in 400 ms, never one per frame.
    expect(checks.length).toBeGreaterThanOrEqual(3);
    expect(checks.length).toBeLessThanOrEqual(7);
  });
});

describe('offline engine waits', () => {
  it('forgets a wait for a connectivity change once it timed out (PT-15)', async () => {
    const offline = engine({ mode: 'hybrid' });
    const internals = offline as unknown as {
      context(): { waitForChange(maxMs: number): Promise<void> };
      waiters: unknown[];
    };
    const context = internals.context();
    await Promise.all([context.waitForChange(5), context.waitForChange(5), context.waitForChange(5)]);
    expect(internals.waiters.length).toBe(0);
  });
});

describe('offline engine endpoints', () => {
  it('checks every host a source spreads its tiles over, not only the first (PT-16)', async () => {
    const net = fakeNetwork((url) => (url.startsWith('https://b.tiles.test') ? 'down' : {}));
    const offline = engine({ fetch: net.fetchImpl, healthChecks: { minIntervalMs: 20, maxIntervalMs: 200 } });
    const source = offline.source(
      xyzImagery({ id: 'abc', url: 'https://{s}.tiles.test/{z}/{x}/{y}.png', subdomains: ['a', 'b', 'c'] }),
    );
    // (x + y) % 3 = 1 picks host b.
    await load(source, tile(2, 1, 0));
    await expect.poll(() => offline.connectivity).toBe('degraded');
  });
});
