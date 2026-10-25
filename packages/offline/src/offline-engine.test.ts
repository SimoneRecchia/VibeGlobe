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
  const requests: { url: string; ifNoneMatch: string | null; atMs: number }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, ifNoneMatch: new Headers(init?.headers).get('If-None-Match'), atMs: Date.now() });
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

  it('tells the engine at every frame whether to keep tiles in memory and prefetch, per source, at runtime (F281–F285, F290)', () => {
    const offline = engine({});
    const a = offline.source(fixture('a'));
    const b = offline.source(fixture('b'));
    expect([a.loadingFlags?.(), b.loadingFlags?.()]).toEqual([3, 3]);
    offline.setSwitches({ memoryReuse: false });
    expect([a.loadingFlags?.(), b.loadingFlags?.()]).toEqual([2, 2]);
    offline.setSwitches({ prefetch: false }, { sourceId: 'b' });
    expect([a.loadingFlags?.(), b.loadingFlags?.()]).toEqual([2, 0]);
    offline.setSwitches({ memoryReuse: true, prefetch: true });
    expect([a.loadingFlags?.(), b.loadingFlags?.()]).toEqual([3, 1]);
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

  it('holds a tile asked for again with nothing changed since its miss until connectivity changes (KB-190)', async () => {
    let portal = true;
    const net = fakeNetwork(() =>
      portal ? { redirected: true, headers: { 'Content-Type': 'text/html' }, body: '<html>login</html>' } : {},
    );
    const offline = engine({ fetch: net.fetchImpl });
    const source = offline.source(fixture());
    expect((await load(source, tile(3, 1, 1))).kind).toBe('aborted');
    await expect.poll(() => offline.connectivity).toBe('offline');
    // The first miss is handed back after a short hold, as before.
    expect((await load(source, tile(3, 2, 2))).kind).toBe('aborted');
    // Asked again with nothing changed: held, not handed back every half second for the whole outage.
    let held: string | undefined;
    void load(source, tile(3, 2, 2)).then((result) => (held = result.kind));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(held).toBeUndefined();
    // Waiting for connectivity, not loading: the engine may go idle meanwhile (KB-194).
    expect(source.heldRequests?.()).toBe(1);
    portal = false;
    await expect.poll(() => offline.connectivity, { timeout: 3000 }).toBe('online');
    // Connectivity changed: the held request is handed back at once, and asked again the tile loads.
    await expect.poll(() => held, { timeout: 1000 }).toBe('aborted');
    expect(source.heldRequests?.()).toBe(0);
    expect(text(await load(source, tile(3, 2, 2)))).toBe('tile');
    expect(net.requests.filter((r) => r.url.endsWith('/3/2/2.png'))).toHaveLength(1);
    // The 1.5 s hold check and the health checks' backoff take longer than the default 5 s.
  }, 15_000);

  it('overrides the network mode for one layer or source while the others keep the global one (F290, KB-184)', async () => {
    const net = fakeNetwork(() => ({}));
    const offline = engine({ fetch: net.fetchImpl });
    const base = offline.source(fixture('base'), { layerId: 'base' });
    const labels = offline.source(fixture('labels'), { layerId: 'labels' });
    const changes: (readonly string[])[] = [];
    offline.on('mode-change', (event) => changes.push(event.sourceIds));
    offline.setMode('offline', { layerId: 'labels' });
    expect([offline.mode, offline.modeOf('base', 'base'), offline.modeOf('labels', 'labels')]).toEqual([
      'hybrid',
      'hybrid',
      'offline',
    ]);
    // The offline-only layer never asks the network; the other keeps loading from it.
    expect((await load(labels, tile(2, 1, 1))).kind).toBe('status');
    expect(text(await load(base, tile(2, 1, 1)))).toBe('tile');
    expect(net.requests.map((r) => r.url).filter((url) => url.endsWith('/2/1/1.png'))).toHaveLength(1);
    // A source's mode applies to every layer that has none of its own; the layer's own wins.
    offline.setMode('online', { sourceId: 'labels' });
    expect(offline.modeOf('labels', 'labels')).toBe('offline');
    offline.setMode('inherit', { layerId: 'labels' });
    expect(offline.modeOf('labels', 'labels')).toBe('online');
    // Leaving offline-only mode names the sources whose tiles may load now.
    expect(changes).toEqual([[], [], ['labels']]);
    expect(text(await load(labels, tile(2, 1, 1)))).toBe('tile');
  });

  it('never health-checks the host of a layer or source in offline-only mode (F292, KB-192)', async () => {
    const net = fakeNetwork(() => ({}));
    const offline = engine({ fetch: net.fetchImpl });
    offline.source(fixture('base'), { layerId: 'base' });
    offline.source(xyzImagery({ id: 'lan', url: 'https://lan.test/{z}/{x}/{y}.png' }), { layerId: 'airgapped' });
    offline.setMode('offline', { layerId: 'airgapped' });
    offline.setMode('online');
    await expect
      .poll(() => net.requests.filter((r) => r.url.startsWith('https://tiles.test/')).length)
      .toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(net.requests.filter((r) => r.url.startsWith('https://lan.test/'))).toHaveLength(0);
    // Back from offline-only: its host is checked again.
    offline.setMode('inherit', { layerId: 'airgapped' });
    await expect
      .poll(() => net.requests.filter((r) => r.url.startsWith('https://lan.test/')).length)
      .toBeGreaterThan(0);
  });

  it('hands back the held tiles of an endpoint that returns while another stays down (KB-194)', async () => {
    const down = new Set(['a.test', 'b.test']);
    const net = fakeNetwork((url) => (down.has(new URL(url).host) ? 'down' : {}));
    const offline = engine({ fetch: net.fetchImpl });
    const host = (name: string) => xyzImagery({ id: name, url: `https://${name}.test/{z}/{x}/{y}.png` });
    const a = offline.source(host('a'));
    const b = offline.source(host('b'));
    offline.source(host('c'));
    await load(b, tile(3, 1, 1));
    expect((await load(a, tile(3, 1, 1))).kind).toBe('aborted');
    await expect.poll(() => offline.connectivity).toBe('degraded');
    expect((await load(a, tile(3, 2, 2))).kind).toBe('aborted');
    let held: string | undefined;
    void load(a, tile(3, 2, 2)).then((result) => (held = result.kind));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(held).toBeUndefined();
    // a returns, b stays down: connectivity stays degraded, but a's held tile is handed back at once.
    down.delete('a.test');
    await expect.poll(() => held, { timeout: 3000 }).toBe('aborted');
    expect(offline.connectivity).toBe('degraded');
  }, 15_000);

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

  it('a failed download waits for a health check that takes longer than 3 s (KB-161)', async () => {
    // The tile fails at once; the check of its endpoint fails only after 3.5 s (within its 5 s limit).
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (!String(input).endsWith('/0/0/0.png')) throw new TypeError('Failed to fetch');
      await new Promise((resolve) => setTimeout(resolve, 3500));
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    const offline = engine({ fetch: fetchImpl });
    expect((await load(offline.source(fixture()), tile(4, 1, 1))).kind).toBe('aborted');
    expect(offline.connectivity).toBe('offline');
  }, 10_000);

  it("a failed download waits for its own endpoint's check, not another endpoint's (KB-161)", async () => {
    // dead.test is down and checked every few milliseconds; the check of the fixture host fails only after 3.5 s.
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://dead.test') || !url.endsWith('/0/0/0.png')) throw new TypeError('Failed to fetch');
      await new Promise((resolve) => setTimeout(resolve, 3500));
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    const offline = engine({ fetch: fetchImpl });
    const dead = offline.source(xyzImagery({ id: 'dead', url: 'https://dead.test/{z}/{x}/{y}.png' }));
    void load(dead, tile(2, 0, 0));
    expect((await load(offline.source(fixture()), tile(4, 1, 1))).kind).toBe('aborted');
  }, 10_000);

  it('marks only the dead endpoint unreachable and backs its checks off (F297)', async () => {
    const net = fakeNetwork((url) => (url.startsWith('https://dead.test') ? 'down' : {}));
    const offline = engine({ fetch: net.fetchImpl, healthChecks: { minIntervalMs: 20, maxIntervalMs: 200 } });
    const dead = offline.source(xyzImagery({ id: 'dead', url: 'https://dead.test/{z}/{x}/{y}.png' }));
    const live = offline.source(fixture());
    await load(dead, tile(2, 0, 0));
    await expect.poll(() => offline.connectivity).toBe('degraded');
    expect(text(await load(live, tile(2, 0, 0)))).toBe('tile');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const checks = net.requests.filter((r) => r.url.startsWith('https://dead.test/0/0/0')).map((r) => r.atMs);
    expect(checks.length).toBeGreaterThanOrEqual(3);
    // The waits double from 20 ms up to 200 ms, never one per frame; a busy machine only delays timers (2 ms of slack
    // for the timer's rounding).
    for (let i = 1; i < checks.length; i++)
      expect((checks[i] ?? 0) - (checks[i - 1] ?? 0)).toBeGreaterThanOrEqual(Math.min(20 * 2 ** (i - 1), 200) - 2);
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

describe('provider profiles (F320)', () => {
  const NAMES = ['persistentCache', 'memoryReuse', 'prefetch', 'offlinePackaging'] as const;

  it('resolves every combination of global, per-source and per-layer setting and profile rule', () => {
    const settings = [undefined, true, false] as const;
    for (const name of NAMES)
      for (const global of settings)
        for (const perSource of settings)
          for (const perLayer of settings)
            for (const forbidden of [false, true]) {
              const offline = engine({});
              offline.source(fixture('s'), {
                layerId: 'l',
                rules: { id: 'p', forbids: new Set(forbidden ? [name] : []), respectCacheHeaders: true },
              });
              if (global !== undefined) offline.setSwitches({ [name]: global });
              if (perSource !== undefined) offline.setSwitches({ [name]: perSource }, { sourceId: 's' });
              if (perLayer !== undefined) offline.setSwitches({ [name]: perLayer }, { layerId: 'l' });
              const expected = global !== false && perSource !== false && perLayer !== false && !forbidden;
              expect(
                offline.effectiveSwitches('s', 'l')[name],
                `${name} ${global} ${perSource} ${perLayer} ${forbidden}`,
              ).toBe(expected);
              // Every other switch stays on: a profile and a setting only touch their own feature.
              for (const other of NAMES.filter((n) => n !== name))
                expect(offline.effectiveSwitches('s', 'l')[other]).toBe(true);
              offline.destroy();
            }
  });

  it('keeps a forbidden feature off when switched on globally or per source, and warns once naming the profile', () => {
    const warnings: string[] = [];
    const offline = engine({ switches: { persistentCache: true } });
    offline.on('warning', (w) => warnings.push(`${w.code}: ${w.message}`));
    offline.source(fixture('strict'), {
      rules: { id: 'strict-provider', forbids: new Set(['persistentCache', 'prefetch']), respectCacheHeaders: true },
    });
    offline.source(fixture('open'));
    offline.setSwitches({ persistentCache: true }, { sourceId: 'strict' });
    offline.setSwitches({ prefetch: true });
    expect(offline.effectiveSwitches('strict')).toEqual({
      persistentCache: false,
      memoryReuse: true,
      prefetch: false,
      offlinePackaging: true,
    });
    expect(offline.effectiveSwitches('open')).toEqual({
      persistentCache: true,
      memoryReuse: true,
      prefetch: true,
      offlinePackaging: true,
    });
    expect(warnings).toEqual([
      "profile-rule: persistentCache stays off for source 'strict': its provider profile 'strict-provider' forbids it",
      "profile-rule: prefetch stays off for source 'strict': its provider profile 'strict-provider' forbids it",
    ]);
  });
});

describe('sources that need their own transport (TB-01)', () => {
  it('downloads through the adapter transport, never fetching its URLs directly', async () => {
    const network = fakeNetwork(() => ({ body: 'direct' }));
    const offline = engine({ fetch: network.fetchImpl, store: memoryStore() });
    const signed: string[] = [];
    const base = fixture('session');
    // A session-based adapter: its transport signs each URL, which is not fetchable as written.
    const source = {
      ...base,
      transportRequired: true,
      transport: {
        start(request: { url: string }, _timeouts: unknown, done: (result: TransportResult) => void) {
          signed.push(`${request.url}?session=1`);
          queueMicrotask(() =>
            done({ kind: 'ok', bytes: new TextEncoder().encode('signed').buffer, contentType: 'image/png' }),
          );
          return () => undefined;
        },
      },
    };
    const wrapped = offline.source(source);
    expect(text(await load(wrapped, tile(3, 1, 2)))).toBe('signed');
    expect(signed).toEqual(['https://tiles.test/3/1/2.png?session=1']);
    expect(network.requests.filter((r) => r.url.includes('tiles.test'))).toEqual([]);
  });

  it('reads archive pseudo URLs through the adapter transport', async () => {
    const network = fakeNetwork(() => ({ body: 'direct' }));
    const offline = engine({ fetch: network.fetchImpl });
    const base = fixture('archive');
    const source: ImagerySource = {
      ...base,
      request(coord, out) {
        out.url = `archive.pmtiles#${coord.level}/${coord.x}/${coord.y}`;
        out.hostIndex = 0;
        return out;
      },
      transport: {
        start(_request, _timeouts, done) {
          queueMicrotask(() =>
            done({ kind: 'ok', bytes: new TextEncoder().encode('archived').buffer, contentType: 'image/png' }),
          );
          return () => undefined;
        },
      },
    };
    expect(text(await load(offline.source(source), tile(2, 1, 1)))).toBe('archived');
    expect(network.requests).toEqual([]);
  });
});

describe('tier counters and aborted requests (TB-03)', () => {
  it('does not count a tile the engine aborted before the persistent cache or a package delivered it', async () => {
    const network = fakeNetwork(() => ({ body: 'net' }));
    const served: string[] = [];
    const offline = engine({ fetch: network.fetchImpl, onServe: (e) => served.push(e.tier) });
    let release: (() => void) | undefined;
    offline.setPackageReader({
      read: () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ bytes: new TextEncoder().encode('pkg').buffer, contentType: 'image/png', packageId: 'p@1' });
        }),
    });
    const source = offline.source(fixture('slow'));
    const request = source.request(tile(2, 1, 1), { url: '', hostIndex: 0 });
    if (request === 'noData' || request === 'unknown') throw new Error('no request');
    const results: string[] = [];
    const abort = source.transport.start(request, TIMEOUTS, (r) => results.push(r.kind));
    await new Promise((resolve) => setTimeout(resolve, 10));
    abort();
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(results).toEqual(['aborted']);
    expect(served).toEqual([]);
    expect(offline.stats('slow').package).toBe(0);
  });

  it('keeps each wrapped source on its own host, so per-host limits stay per host (KB-156)', () => {
    const offline = engine({});
    const origin = (source: ImagerySource): string | undefined =>
      /^[a-z][a-z0-9+.-]*:\/\/[^/]+/i.exec(
        (source.request(tile(3, 1, 2), { url: '', hostIndex: 0 }) as { url: string }).url,
      )?.[0];
    const a = offline.source(xyzImagery({ id: 'a', url: 'https://a.test/{z}/{x}/{y}.png' }));
    const b = offline.source(xyzImagery({ id: 'b', url: 'https://b.test/{z}/{x}/{y}.png' }));
    expect([origin(a), origin(b)]).toEqual(['vibeglobe-tile://a.test', 'vibeglobe-tile://b.test']);
  });

  it('passes a tile whose availability is not known yet through as unknown, not as a request that fails (KB-157)', () => {
    const offline = engine({});
    const later: ImagerySource = { ...fixture('later'), request: () => 'unknown' };
    expect(offline.source(later).request(tile(5, 1, 1), { url: '', hostIndex: 0 })).toBe('unknown');
  });

  it('names the sources to reload when it leaves offline-only mode, whose misses read as no data (KB-158)', () => {
    const offline = engine({});
    offline.source(fixture('a'));
    offline.source(fixture('b'));
    const events: { mode: string; sourceIds?: readonly string[] }[] = [];
    offline.on('mode-change', (event) => events.push(event));
    offline.setMode('offline');
    offline.setMode('hybrid');
    expect(events).toEqual([
      { mode: 'offline', sourceIds: [] },
      { mode: 'hybrid', sourceIds: ['a', 'b'] },
    ]);
  });
});
