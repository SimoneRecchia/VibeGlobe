import { describe, expect, it, vi } from 'vitest';
import type { TileCoord, TransportResult } from '@vibeglobe/core';
import { failures, runTiledConformance } from '../conformance/index.js';
import { fixtureCopyright, GOOGLE_FIXTURE_KEY, googleFixture } from '../__fixtures__/google-server.js';
import type { DescribedImagerySource } from '../metadata.js';
import { SourceConfigError } from '../metadata.js';
import { followGoogleCopyrights, googleImagery, googleProfile } from './google-provider.js';
import { googleStreetView } from './google-street-view-provider.js';
import { OSM_PUBLIC_PROFILE, openStreetMapImagery } from './openstreetmap-provider.js';

const encoder = new TextEncoder();
const tileBytes = (z: number, x: number, y: number): Uint8Array => encoder.encode(`google ${z}/${x}/${y}`);
const coord = (level: number, x: number, y: number): TileCoord => ({ root: 0, level, x, y });
const base = { apiKey: GOOGLE_FIXTURE_KEY, billingRegion: 'eea' as const };

function fetchVia(source: DescribedImagerySource, c: TileCoord): Promise<TransportResult | 'noData'> {
  const request = source.request(c, { url: '', hostIndex: 0 });
  if (request === 'noData' || request === 'unknown') return Promise.resolve('noData');
  return new Promise((resolve) => source.transport.start(request, { firstByteMs: 1000, totalMs: 2000 }, resolve));
}

describe('Google profile (F256, F261)', () => {
  it('maps the rules of ADR 0031 for each billing region and refuses a missing one', () => {
    const eea = googleProfile('eea');
    const other = googleProfile('other', 'https://app.test/google-logo.png');
    for (const profile of [eea, other]) {
      expect([...profile.forbids].sort()).toEqual(['offlinePackaging', 'persistentCache', 'prefetch']);
      expect([profile.respectCacheHeaders, profile.displayOnly, profile.termsAdr]).toEqual([
        true,
        true,
        'docs/adr/0031-google-maps-platform-terms.md',
      ]);
    }
    expect([eea.storableIds, eea.termsUrl]).toEqual([
      ['placeId', 'panoId'],
      'https://cloud.google.com/terms/maps-platform/eea',
    ]);
    expect([other.storableIds, other.termsUrl]).toEqual([['placeId'], 'https://cloud.google.com/maps-platform/terms']);
    expect(other.requiredAttribution).toEqual({
      text: 'Google',
      logo: { src: 'https://app.test/google-logo.png', alt: 'Google' },
    });
    expect(() => googleProfile(undefined)).toThrow(SourceConfigError);
  });
});

describe('googleImagery (F257, F258)', () => {
  it('creates a session with the map type, language and region, and every tile request carries its token', async () => {
    const server = googleFixture(tileBytes);
    const source = await googleImagery({
      ...base,
      id: 'g',
      mapType: 'satellite',
      language: 'it-IT',
      region: 'IT',
      fetch: server.fetch,
    });
    expect(server.requests[0]).toEqual({
      url: `https://tile.googleapis.com/v1/createSession?key=${GOOGLE_FIXTURE_KEY}`,
      body: { language: 'it-IT', region: 'IT', mapType: 'satellite' },
    });
    const request = source.request(coord(3, 4, 2), { url: '', hostIndex: 0 });
    // The engine sees neither the key nor the session (ADR 0031, F253).
    expect(request).toEqual({ url: 'https://tile.googleapis.com/v1/2dtiles/3/4/2', hostIndex: 0 });
    const tile = await fetchVia(source, coord(3, 4, 2));
    expect(tile !== 'noData' && tile.kind === 'ok' && new TextDecoder().decode(tile.bytes)).toBe('google 3/4/2');
    expect(server.requests.at(-1)?.url).toBe(
      `https://tile.googleapis.com/v1/2dtiles/3/4/2?session=session-1&key=${GOOGLE_FIXTURE_KEY}`,
    );
    await expect(
      googleImagery({ ...base, id: 'x', mapType: 'roadmap', apiKey: 'wrong', fetch: server.fetch }),
    ).rejects.toThrow(/session/);
  });

  it("reports how long Google's cache headers let the engine reuse a tile (F260)", async () => {
    const server = googleFixture(tileBytes);
    const source = await googleImagery({ ...base, id: 'g', mapType: 'roadmap', fetch: server.fetch });
    const tile = await fetchVia(source, coord(3, 4, 2));
    expect(tile !== 'noData' && tile.kind === 'ok' && tile.maxAgeMs).toBe(300_000);
  });

  it('renews an expired session transparently, once, and keeps delivering tiles', async () => {
    const server = googleFixture(tileBytes);
    const source = await googleImagery({ ...base, id: 'g', mapType: 'roadmap', fetch: server.fetch });
    server.expireSessions();
    // A burst of refused tiles renews the session once.
    const burst = [coord(2, 1, 1), coord(2, 2, 1), coord(2, 3, 1), coord(3, 1, 1), coord(3, 2, 1)];
    const results = await Promise.all(burst.map((c) => fetchVia(source, c)));
    expect(results.every((r) => r !== 'noData' && r.kind === 'ok')).toBe(true);
    expect(source.sessionsCreated()).toBe(2);
    expect(server.requests.filter((r) => r.url.includes('createSession')).length).toBe(source.sessionsCreated());
    expect(server.requests.at(-1)?.url).toMatch(/session=session-2&/);
  });

  it('asks the viewport endpoint once per settled view and returns its copyright', async () => {
    const server = googleFixture(tileBytes);
    const source = await googleImagery({ ...base, id: 'g', mapType: 'roadmap', fetch: server.fetch });
    const west = { zoom: 5.4, westDeg: -10, southDeg: 40, eastDeg: -2, northDeg: 45 };
    const east = { zoom: 6, westDeg: 8, southDeg: 40, eastDeg: 16, northDeg: 45 };
    // A frame loop asking on every frame of a settled view repeats no request.
    const answers = await Promise.all([
      source.viewportCopyright(west),
      source.viewportCopyright(west),
      source.viewportCopyright(west),
    ]);
    expect(answers).toEqual(Array(3).fill(fixtureCopyright(-10)));
    expect(await source.viewportCopyright(east)).toBe(fixtureCopyright(8));
    const viewport = server.requests.filter((r) => r.url.includes('/tile/v1/viewport'));
    expect(viewport).toHaveLength(2);
    expect(viewport[0]?.url).toContain('zoom=5&north=45.000000&south=40.000000&east=-2.000000&west=-10.000000');
  });

  it('follows the settled view: one viewport request per settled view, its copyright after the logo (F258)', async () => {
    const server = googleFixture(tileBytes);
    const source = await googleImagery({ ...base, id: 'g', mapType: 'roadmap', fetch: server.fetch });
    let idle: (() => void) | undefined;
    let tiles = [{ westDeg: -10, southDeg: 40, eastDeg: -2, northDeg: 45 }];
    const refreshes: string[][] = [];
    const globe = {
      camera: { zoom: 6 },
      on: (_event: 'idle', handler: () => void) => ((idle = handler), () => (idle = undefined)),
      surfaceTiles: () => tiles,
      refreshCredits: () => refreshes.push(source.attribution.map((a) => a.text)),
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
    const stop = followGoogleCopyrights(globe, source);
    await settle();
    idle?.();
    idle?.();
    await settle();
    tiles = [{ westDeg: 8, southDeg: 40, eastDeg: 16, northDeg: 45 }];
    idle?.();
    await settle();
    expect(server.requests.filter((r) => r.url.includes('/tile/v1/viewport'))).toHaveLength(2);
    expect(source.attribution.map((a) => a.text)).toEqual(['Google', fixtureCopyright(8)]);
    expect(refreshes.at(0)).toEqual(['Google', fixtureCopyright(-10)]);
    stop();
    expect(idle).toBeUndefined();
  });

  it('passes the tiled conformance suite, with every request carrying the session token', async () => {
    const server = googleFixture(tileBytes);
    const results = await runTiledConformance({
      name: 'google 2D tiles',
      create: (fetchImpl) => googleImagery({ ...base, id: 'g', mapType: 'terrain', fetch: fetchImpl }),
      fixture: server.fetch,
      tiles: [coord(0, 0, 0), coord(5, 17, 11)].map((c) => ({ coord: c, bytes: tileBytes(c.level, c.x, c.y) })),
      missing: [coord(20, 1, 1)],
      profileChecks: [
        (_, requests) =>
          requests.filter((u) => u.includes('/2dtiles/')).every((u) => /session=session-\d+&key=/.test(u))
            ? undefined
            : 'a tile request without a session',
        (source) =>
          source.profile.forbids.has('prefetch') && source.profile.forbids.has('offlinePackaging')
            ? undefined
            : 'prefetch or packaging allowed',
        (source) => (source.attribution.some((a) => a.text === 'Google') ? undefined : 'no Google attribution'),
      ],
    });
    expect(failures(results)).toEqual([]);
  });
});

describe('googleStreetView (F262)', () => {
  it('reads metadata and panorama tiles with the session token, never cached, under the Google profile', async () => {
    const server = googleFixture(tileBytes);
    const streetView = await googleStreetView({ ...base, fetch: server.fetch });
    expect(server.requests[0]?.body).toMatchObject({ mapType: 'streetview' });
    const near = await streetView.metadata({ latitudeDeg: 45.83, longitudeDeg: 6.86, radiusMeters: 50 });
    expect(near).toMatchObject({ panoId: 'pano-near', tileWidthPx: 512, copyright: '© 2024 Google' });
    expect(await streetView.metadata({ panoId: 'missing' })).toBeUndefined();
    const spy = vi.fn(server.fetch);
    const cached = await googleStreetView({ ...base, fetch: spy });
    expect(new Uint8Array((await cached.tile('pano-near', 2, 1, 0)) ?? new ArrayBuffer(0))).toEqual(
      new Uint8Array([0xff, 0xd8, 0xff]),
    );
    const [url, init] = spy.mock.calls.at(-1) ?? [];
    expect(String(url)).toMatch(/\/v1\/streetview\/tiles\/2\/1\/0\?panoId=pano-near&session=session-\d+&key=/);
    expect(init?.cache).toBe('no-store');
    expect(streetView.profile.forbids.has('persistentCache')).toBe(true);
    expect(streetView.attribution).toEqual([{ text: 'Google' }]);
  });
});

describe('openStreetMapImagery (F263–F267)', () => {
  it('requires the application to identify itself and maps the ADR 0032 rules', () => {
    expect(() => openStreetMapImagery({ appName: '', appUrl: 'https://app.test/', warn: () => undefined })).toThrow(
      SourceConfigError,
    );
    expect(() => openStreetMapImagery({ appName: 'App', appUrl: 'not a url', warn: () => undefined })).toThrow(
      /identify itself/,
    );
    const warnings: string[] = [];
    const source = openStreetMapImagery({
      appName: 'Demo',
      appUrl: 'https://demo.test/',
      warn: (m) => warnings.push(m),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/unsuitable for production/);
    expect(source.maxRequestsPerHost).toBe(2);
    expect(source.profile).toBe(OSM_PUBLIC_PROFILE);
    expect([...OSM_PUBLIC_PROFILE.forbids].sort()).toEqual(['offlinePackaging', 'persistentCache', 'prefetch']);
    expect(source.attribution).toEqual([
      { text: '© OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright' },
    ]);
  });

  it('identifies the application on every request and never sends no-cache headers', async () => {
    const calls: RequestInit[] = [];
    const fake: typeof fetch = (_input, init) => {
      calls.push(init ?? {});
      return Promise.resolve(new Response(encoder.encode('png'), { headers: { 'Content-Type': 'image/png' } }));
    };
    const source = openStreetMapImagery({
      appName: 'Demo',
      appUrl: 'https://demo.test/',
      fetch: fake,
      warn: () => undefined,
    });
    await fetchVia(source, coord(3, 4, 2));
    const init = calls[0] ?? {};
    expect([init.referrerPolicy, init.cache]).toEqual(['strict-origin-when-cross-origin', 'default']);
    const headers = new Headers(init.headers);
    expect(headers.get('User-Agent')).toBe('Demo (https://demo.test/)');
    expect([headers.has('Cache-Control'), headers.has('Pragma')]).toEqual([false, false]);
  });

  it('passes the tiled conformance suite against a recorded-behavior fixture of the raster servers', async () => {
    const tile = encoder.encode('osm');
    const server: typeof fetch = (input) =>
      Promise.resolve(
        /\/(\d+)\/(\d+)\/(\d+)\.png$/.test(String(input)) && !String(input).includes('/19/')
          ? new Response(tile.slice())
          : new Response(null, { status: 404 }),
      );
    const results = await runTiledConformance({
      name: 'openstreetmap public',
      create: (fetchImpl) =>
        openStreetMapImagery({
          appName: 'Demo',
          appUrl: 'https://demo.test/',
          fetch: fetchImpl,
          warn: () => undefined,
        }),
      fixture: server,
      tiles: [coord(0, 0, 0), coord(12, 2189, 1489)].map((c) => ({ coord: c, bytes: tile })),
      missing: [coord(19, 280000, 190000)],
      profileChecks: [(source) => (source.profile.forbids.has('prefetch') ? undefined : 'prefetch allowed')],
    });
    expect(failures(results)).toEqual([]);
  });
});
