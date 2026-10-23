import { describe, expect, it } from 'vitest';
import type { TileCoord } from '@vibeglobe/core';
import { fetchTransport } from '../fetch-transport.js';
import { CUSTOM_PROFILE, withProfile } from '../metadata.js';
import { xyzImagery } from '../xyz-imagery.js';
import { failures, runTiledConformance } from './index.js';

const coord = (level: number, x: number, y: number): TileCoord => ({ root: 0, level, x, y });
const DEG = Math.PI / 180;

describe('tiled conformance suite (F223)', () => {
  it('passes for the XYZ adapter with its attribution and profile', async () => {
    const bytes = new TextEncoder().encode('png');
    const service: typeof fetch = (input) =>
      Promise.resolve(
        String(input).endsWith('/6/34/22.png') ? new Response(null, { status: 404 }) : new Response(bytes.slice()),
      );
    const results = await runTiledConformance({
      name: 'xyz',
      create: (fetchImpl) => ({
        ...xyzImagery({
          id: 'xyz',
          url: 'https://{s}.tiles.test/{z}/{x}/{y}.png',
          subdomains: ['a', 'b'],
          minLevel: 2,
          maxLevel: 12,
          coverage: [{ westRad: 6 * DEG, southRad: 36 * DEG, eastRad: 19 * DEG, northRad: 47.5 * DEG }],
          transport: fetchTransport(fetchImpl),
        }),
        attribution: [{ text: '© Tiles' }],
        profile: CUSTOM_PROFILE,
      }),
      fixture: service,
      tiles: [coord(6, 34, 23), coord(2, 2, 1)].map((c) => ({ coord: c, bytes })),
      missing: [coord(6, 34, 22)],
      outside: [coord(6, 18, 24)],
    });
    expect(failures(results)).toEqual([]);
  });

  it('reports what an adapter gets wrong', async () => {
    const results = await runTiledConformance({
      name: 'broken',
      // No attribution or profile, levels inverted, and a transport that answers twice.
      create: () => ({
        ...xyzImagery({ id: 'broken', url: '/{z}/{x}/{y}', minLevel: 5, maxLevel: 3 }),
        transport: {
          start: (_request, _timeouts, done) => (
            done({ kind: 'network-error' }),
            done({ kind: 'network-error' }),
            () => undefined
          ),
        },
      }),
      fixture: () => Promise.resolve(new Response(null, { status: 404 })),
      tiles: [{ coord: coord(4, 1, 1) }],
    });
    const failed = failures(results).join('\n');
    for (const area of ['attribution', 'zoom range', 'provider profile', 'addressing', 'error handling'])
      expect(failed).toContain(area);
  });

  it("enforces a provider adapter's own profile like the built-in ones (F326)", async () => {
    const bytes = new TextEncoder().encode('png');
    const acme = {
      id: 'acme',
      forbids: new Set(['persistentCache', 'offlinePackaging'] as const),
      respectCacheHeaders: true,
      maxConcurrentRequests: 2,
      requiredAttribution: { text: 'Acme Maps', logo: { src: 'https://acme.test/logo.png', alt: 'Acme' } },
    };
    const subject = (declared: typeof acme | typeof CUSTOM_PROFILE) => ({
      name: 'acme',
      create: (fetchImpl: typeof fetch) =>
        withProfile(
          xyzImagery({ id: 'acme', url: 'https://acme.test/{z}/{x}/{y}.png', transport: fetchTransport(fetchImpl) }),
          declared,
        ),
      fixture: () => Promise.resolve(new Response(bytes.slice())),
      tiles: [{ coord: coord(3, 1, 2), bytes }],
      profileChecks: [
        (source: { profile: { forbids: ReadonlySet<string> } }) =>
          source.profile.forbids.has('offlinePackaging') ? undefined : 'packaging is not forbidden',
      ],
    });
    const results = await runTiledConformance(subject(acme));
    expect(failures(results)).toEqual([]);
    const names = results.filter((r) => r.area === 'provider profile').map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'keeps per-host concurrency within the profile limit',
        'shows the attribution the profile requires',
        'shows the logo the profile requires',
      ]),
    );
    // The same adapter without its profile fails the adapter's own rule.
    expect(failures(await runTiledConformance(subject(CUSTOM_PROFILE)))).toEqual([
      'acme provider profile: packaging is not forbidden',
    ]);
  });
});
