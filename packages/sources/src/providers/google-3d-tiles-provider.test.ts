// Google Photorealistic 3D Tiles sessions (F468, F469) and profile (F470): the key and session only on the adapter's
// own requests, a new session before the lifetime ends, one renewal and a retry when Google refuses a token.
import type { TransportResult } from '@vibeglobe/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { google3dTiles } from './google-3d-tiles-provider.js';

const ROOT = 'https://tile.googleapis.com/v1/3dtiles/root.json';
const TILE = 'https://tile.googleapis.com/v1/3dtiles/datasets/x/files/tile.glb?session=from-tileset';

/** A Map Tiles API stand-in: sessions `s1`, `s2`, … from the root; tokens in `refuse` answer 400. */
function api(refuse: Set<string> = new Set()) {
  const urls: string[] = [];
  let sessions = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    urls.push(url.href);
    if (url.pathname.endsWith('/root.json')) {
      sessions++;
      return new Response(JSON.stringify({ root: { content: { uri: `/v1/3dtiles/a.json?session=s${sessions}` } } }));
    }
    const session = url.searchParams.get('session') ?? '';
    if (refuse.has(session)) return new Response('expired', { status: 400 });
    return new Response(new Uint8Array([1, 2, 3]));
  }) as typeof fetch;
  return { fetchImpl, urls, sessions: () => sessions };
}

function load(transport: ReturnType<typeof google3dTiles>['transport'], url: string): Promise<TransportResult> {
  return new Promise((resolve) => transport.start({ url, hostIndex: 0 }, { firstByteMs: 1e4, totalMs: 1e4 }, resolve));
}

afterEach(() => vi.useRealTimers());

describe('google3dTiles (F468–F470)', () => {
  it('starts a session from the root tileset and signs every request with it and the key, never the engine URL', async () => {
    const { fetchImpl, urls } = api();
    const google = google3dTiles({ apiKey: 'K', billingRegion: 'other', fetch: fetchImpl });
    expect(google.url).toBe(ROOT);
    expect((await load(google.transport, google.url)).kind).toBe('ok');
    expect((await load(google.transport, TILE)).kind).toBe('ok');
    expect(urls).toEqual([`${ROOT}?key=K`, TILE.replace('from-tileset', 's1') + '&key=K']);
    expect(google.sessionsCreated()).toBe(1);
  });

  it('starts a new session before the lifetime ends, so no request uses an expired token', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { fetchImpl, urls } = api();
    const google = google3dTiles({ apiKey: 'K', billingRegion: 'other', fetch: fetchImpl, sessionLifetimeMs: 50_000 });
    await load(google.transport, google.url);
    vi.advanceTimersByTime(49_000);
    await load(google.transport, TILE);
    vi.advanceTimersByTime(2_000);
    await load(google.transport, TILE);
    expect(google.sessionsCreated()).toBe(2);
    expect(urls.filter((u) => u.includes('tile.glb')).map((u) => new URL(u).searchParams.get('session'))).toEqual([
      's1',
      's2',
    ]);
  });

  it('renews once and retries when Google refuses a token, for a burst of refused requests', async () => {
    const { fetchImpl, sessions } = api(new Set(['s1']));
    const google = google3dTiles({ apiKey: 'K', billingRegion: 'other', fetch: fetchImpl });
    await load(google.transport, google.url);
    const results = await Promise.all([load(google.transport, TILE), load(google.transport, TILE)]);
    expect(results.map((r) => r.kind)).toEqual(['ok', 'ok']);
    expect(sessions()).toBe(2);
  });

  it('applies the Google profile: display only, no persistent cache, prefetch or offline packaging', () => {
    const { profile } = google3dTiles({ apiKey: 'K', billingRegion: 'other', fetch: api().fetchImpl });
    expect(profile.displayOnly).toBe(true);
    expect([...profile.forbids].sort()).toEqual(['offlinePackaging', 'persistentCache', 'prefetch']);
    expect(profile.requiredAttribution?.text).toBe('Google Maps');
  });

  it('refuses an EEA billing account, which the Map Tiles API answers 403 (ADR 0031)', () => {
    expect(() => google3dTiles({ apiKey: 'K', billingRegion: 'eea', fetch: api().fetchImpl })).toThrow(
      /Photorealistic 3D Tiles are not available to billing accounts in the European Economic Area/,
    );
  });

  it('refuses a missing key with a configuration error', () => {
    expect(() => google3dTiles({ apiKey: '', billingRegion: 'other' })).toThrow(/apiKey is required/);
  });
});
