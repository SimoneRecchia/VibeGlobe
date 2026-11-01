import { describe, expect, it, vi } from 'vitest';
import type { ImagerySource, TileCoord, TransportResult } from '@vibeglobe/core';
import { failures, runTiledConformance } from '../conformance/index.js';
import { SourceConfigError } from '../metadata.js';
import { xyzImagery } from '../xyz-imagery.js';
import { OSM_PUBLIC_PROFILE, openStreetMapImagery } from './openstreetmap-provider.js';

const encoder = new TextEncoder();

const coord = (level: number, x: number, y: number): TileCoord => ({ root: 0, level, x, y });

function fetchVia(source: ImagerySource, c: TileCoord): Promise<TransportResult | 'noData'> {
  const request = source.request(c, { url: '', hostIndex: 0 });
  if (request === 'noData' || request === 'unknown') return Promise.resolve('noData');
  return new Promise((resolve) => source.transport.start(request, { firstByteMs: 1000, totalMs: 2000 }, resolve));
}

describe('openStreetMapImagery (F263–F267)', () => {
  it('refuses subdomain URLs and links a way to report map issues (ADR 0032, owner reading 2026-10-24)', () => {
    const identity = { appName: 'App', appUrl: 'https://app.test/', warn: () => undefined };
    expect(() =>
      openStreetMapImagery({ ...identity, url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png' }),
    ).toThrow(/without subdomains/);
    expect(() =>
      openStreetMapImagery({ ...identity, url: 'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png' }),
    ).toThrow(/without subdomains/);
    expect(openStreetMapImagery(identity).attribution).toContainEqual({
      text: 'Report a map issue',
      url: 'https://www.openstreetmap.org/fixthemap',
    });
  });

  it('requires the application to identify itself and maps the ADR 0032 rules', () => {
    expect(() => openStreetMapImagery({ appName: '', appUrl: 'https://app.test/', warn: () => undefined })).toThrow(
      SourceConfigError,
    );
    expect(() => openStreetMapImagery({ appName: 'App', appUrl: 'not a url', warn: () => undefined })).toThrow(
      /identify itself/,
    );
    // Without a `warn` sink nothing is logged when sources are created: the profile carries the warning, which the
    // engine logs once per instance however many sources use it (KB-PT-07).
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const first = openStreetMapImagery({ appName: 'Demo', appUrl: 'https://demo.test/' });
    openStreetMapImagery({ appName: 'Demo', appUrl: 'https://demo.test/', id: 'osm-2' });
    expect(consoleWarn).not.toHaveBeenCalled();
    consoleWarn.mockRestore();
    expect(first.profile.warning).toMatch(/unsuitable for production/);
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
      { text: 'Report a map issue', url: 'https://www.openstreetmap.org/fixthemap' },
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

describe('a provider the application connects itself (F679)', () => {
  it('takes a keyed service with session tokens through xyzImagery, its own transport and its own profile', async () => {
    // The application's code: a session created once, its token and key added only by the transport, the provider's
    // logo always shown and its tiles for display only, as a commercial provider's terms ask.
    let sessions = 0;
    const requested: string[] = [];
    const session = (): Promise<string> => Promise.resolve(`s${String(++sessions)}`);
    const token = session();
    const source = xyzImagery({
      id: 'provider',
      url: 'https://tiles.provider.test/v1/2dtiles/{z}/{x}/{y}',
      transport: {
        start(request, _timeouts, done) {
          void token.then((t) => {
            requested.push(`${request.url}?session=${t}&key=app-key`);
            done({ kind: 'ok', bytes: encoder.encode('tile').buffer, contentType: 'image/png' });
          });
          return () => undefined;
        },
      },
      attribution: [{ text: 'Provider', logo: { src: 'https://app.test/logo.png', alt: 'Provider' } }],
      profile: {
        id: 'provider',
        requiredAttribution: { text: 'Provider' },
        displayOnly: true,
        respectCacheHeaders: true,
      },
    });
    expect(await fetchVia(source, coord(3, 4, 2))).toMatchObject({ kind: 'ok' });
    expect(await fetchVia(source, coord(3, 4, 3))).toMatchObject({ kind: 'ok' });
    // The engine sees the URL without key or session; one session served both tiles.
    expect(source.request(coord(3, 4, 2), { url: '', hostIndex: 0 })).toMatchObject({
      url: 'https://tiles.provider.test/v1/2dtiles/3/4/2',
    });
    expect(requested).toEqual([
      'https://tiles.provider.test/v1/2dtiles/3/4/2?session=s1&key=app-key',
      'https://tiles.provider.test/v1/2dtiles/3/4/3?session=s1&key=app-key',
    ]);
    expect(source.profile).toMatchObject({ displayOnly: true, requiredAttribution: { text: 'Provider' } });
  });
});
