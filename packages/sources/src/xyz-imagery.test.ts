import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import type { TileCoord } from '@vibeglobe/core';
import { failures, runTiledConformance } from './conformance/index.js';
import { fetchTransport } from './fetch-transport.js';
import { CUSTOM_PROFILE, SourceConfigError } from './metadata.js';
import { xyzImagery } from './xyz-imagery.js';

const coord = { root: 0 as const, level: 3, x: 5, y: 2 };
const tile = (level: number, x: number, y: number): TileCoord => ({ root: 0, level, x, y });

describe('xyzImagery high-DPI variants (F241)', () => {
  it('fills {r} with @2x only when the engine asks for pixel ratio 2, and declares the source high-DPI', () => {
    const source = xyzImagery({ id: 'a', url: 'https://t/{z}/{x}/{y}{r}.png' });
    expect(source.highDpi).toBe(true);
    const out = { url: '', hostIndex: 0 };
    expect(source.request(coord, out)).toMatchObject({ url: 'https://t/3/5/2.png' });
    expect(source.request(coord, out, 1)).toMatchObject({ url: 'https://t/3/5/2.png' });
    expect(source.request(coord, out, 2)).toMatchObject({ url: 'https://t/3/5/2@2x.png' });
  });

  it('leaves a template without {r} at one variant', () => {
    const source = xyzImagery({ id: 'a', url: 'https://t/{z}/{x}/{y}.png' });
    expect(source.highDpi).toBeUndefined();
    expect(source.request(coord, { url: '', hostIndex: 0 }, 2)).toMatchObject({ url: 'https://t/3/5/2.png' });
  });
});

describe('XYZ and TMS addressing (F229)', () => {
  /** A recorded service in XYZ (rows from the north) or TMS (rows from the south) addressing; one tile is missing. */
  function service(tms: boolean): { fetch: typeof fetch; headers: Headers[] } {
    const headers: Headers[] = [];
    return {
      headers,
      fetch: (input, init) => {
        headers.push(new Headers(init?.headers));
        const match = /\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(String(input));
        const [z, x, row] = (match?.slice(1) ?? []).map(Number);
        const y = tms && z !== undefined && row !== undefined ? 2 ** z - 1 - row : row;
        const missing = z === 6 && x === 34 && y === 22;
        return Promise.resolve(
          match && !missing
            ? new Response(new TextEncoder().encode(`${z}/${x}/${y}`))
            : new Response(null, { status: 404 }),
        );
      },
    };
  }

  for (const tms of [false, true]) {
    it(`passes the tiled conformance suite with ${tms ? 'TMS' : 'XYZ'} addressing`, async () => {
      const fixture = service(tms);
      const results = await runTiledConformance({
        name: tms ? 'tms' : 'xyz',
        create: (fetchImpl) => ({
          ...xyzImagery({
            id: 'fixture',
            url: `https://{s}.tiles.test/{z}/{x}/${tms ? '{-y}' : '{y}'}.png`,
            subdomains: ['a', 'b', 'c'],
            minLevel: 2,
            maxLevel: 12,
            transport: fetchTransport(fetchImpl),
          }),
          attribution: [{ text: '© Fixture' }],
          profile: CUSTOM_PROFILE,
        }),
        fixture: fixture.fetch,
        tiles: [tile(6, 34, 23), tile(2, 2, 1), tile(9, 270, 171)].map((c) => ({
          coord: c,
          bytes: new TextEncoder().encode(`${c.level}/${c.x}/${c.y}`),
        })),
        missing: [tile(6, 34, 22)],
      });
      expect(failures(results)).toEqual([]);
    });
  }

  test.prop([
    fc.integer({ min: 0, max: 20 }).chain((level) =>
      fc.record({
        level: fc.constant(level),
        x: fc.integer({ min: 0, max: 2 ** level - 1 }),
        y: fc.integer({ min: 0, max: 2 ** level - 1 }),
      }),
    ),
    fc.boolean(),
  ])(
    'requests the URL its template names, rotating subdomains by tile and flipping TMS rows',
    ({ level, x, y }, tms) => {
      const subdomains = ['a', 'b', 'c'];
      const source = xyzImagery({
        id: 'p',
        url: `https://{s}.t/{z}/{x}/${tms ? '{-y}' : '{y}'}.png?v=1`,
        subdomains,
        maxLevel: 20,
      });
      const request = source.request({ root: 0, level, x, y }, { url: '', hostIndex: 0 });
      const host = (x + y) % 3;
      const row = tms ? 2 ** level - 1 - y : y;
      expect(request).toEqual({ url: `https://${subdomains[host]}.t/${level}/${x}/${row}.png?v=1`, hostIndex: host });
    },
  );

  it('sends custom headers with every request through the default transport', async () => {
    const fixture = service(false);
    const source = xyzImagery({
      id: 'h',
      url: 'https://t/{z}/{x}/{y}.png',
      headers: { 'X-Api-Key': 'fixture-key' },
    });
    const original = globalThis.fetch;
    globalThis.fetch = fixture.fetch;
    try {
      const request = source.request(tile(2, 1, 1), { url: '', hostIndex: 0 });
      if (request === 'noData' || request === 'unknown') throw new Error('no request');
      await new Promise((resolve) => source.transport.start(request, { firstByteMs: 1000, totalMs: 1000 }, resolve));
    } finally {
      globalThis.fetch = original;
    }
    expect(fixture.headers.map((h) => h.get('X-Api-Key'))).toEqual(['fixture-key']);
  });

  it.each([
    ['https://t/{z}/{x}.png', /must contain \{y\}/],
    ['https://t/{z}/{y}.png', /must contain \{x\}/],
    ['https://t/{x}/{y}.png', /must contain \{z\}/],
    ['https://t/{z}/{x}/{y}.png?k={key}', /unknown field \{key\}/],
    ['https://t/{z}/{x}/{y.png', /unpaired brace/],
    ['https://{s}.t/{z}/{x}/{y}.png', /\{s\} without subdomains/],
  ])('rejects the template %s with a descriptive error', (url, message) => {
    expect(() => xyzImagery({ id: 'bad', url })).toThrowError(message);
  });

  test.prop([fc.string({ maxLength: 40 }), fc.constantFrom('', '{z}', '{x}', '{y}', '{-y}', '{s}', '{r}', '{', '}')])(
    'fuzzed templates either work or are rejected with a SourceConfigError',
    (text, field) => {
      const url = `https://t/{z}/{x}/${text}${field}`;
      let source;
      try {
        source = xyzImagery({ id: 'f', url, subdomains: ['a'] });
      } catch (error) {
        expect(error).toBeInstanceOf(SourceConfigError);
        expect((error as SourceConfigError).message).toContain('The URL template');
        return;
      }
      const request = source.request(tile(4, 3, 9), { url: '', hostIndex: 0 });
      expect(request).not.toBe('noData');
      if (typeof request === 'object') expect(request.url).not.toMatch(/\{(z|x|-?y|s|r)\}/);
    },
  );
});

describe('xyzImagery coverage area', () => {
  it('requests no tile outside its polygons or beyond its levels, and exposes their bounds as its coverage', () => {
    const square: [number, number][] = [
      [10, 46],
      [16, 46],
      [16, 49],
      [10, 49],
      [10, 46],
    ];
    const source = xyzImagery({
      id: 'ortho',
      url: 'https://t/{z}/{x}/{y}.jpg',
      maxLevel: 12,
      area: { polygons: [[square]] },
    });
    const out = { url: '', hostIndex: 0 };
    // Level 10 tiles of Web Mercator: x = 540 is about 9.8°–10.2° E (the western edge), 550 about 13.4° E.
    expect(source.request(tile(10, 550, 354), out)).toMatchObject({ url: 'https://t/10/550/354.jpg' });
    expect(source.request(tile(10, 540, 354), out)).toBe('noData');
    expect(source.request(tile(10, 600, 354), out)).toBe('noData');
    expect(source.request(tile(13, 4400, 2832), out)).toBe('noData');
    expect(source.coverage?.length).toBe(1);
  });

  it('clips a GeoJSON area per pixel: border tiles requested with a mask, the source transparent; blankTile parsed (F618)', () => {
    const source = xyzImagery({
      id: 'ortho',
      url: 'https://t/{z}/{x}/{y}.jpg',
      area: {
        type: 'Polygon',
        coordinates: [
          [
            [10, 46],
            [16, 46],
            [16, 49],
            [10, 49],
            [10, 46],
          ],
        ],
      },
      blankTile: '#ffffff',
    });
    const out = { url: '', hostIndex: 0 };
    expect(source.transparent).toBe(true);
    expect(source.blankTile).toEqual({ rgb: [255, 255, 255] });
    // Level 10, x = 540 straddles 10° E: requested now, with the outline over it; x = 550 lies wholly inside.
    expect(source.request(tile(10, 540, 354), out)).toMatchObject({ url: 'https://t/10/540/354.jpg' });
    expect(source.tileMask?.(tile(10, 540, 354))?.ringEnds.length).toBe(1);
    expect(source.tileMask?.(tile(10, 550, 354))).toBeUndefined();
    expect(() => xyzImagery({ id: 'x', url: 'https://t/{z}/{x}/{y}.jpg', blankTile: 'white' })).toThrow(/#rrggbb/);
    // A filler with a caption: the share of its pixels that are the color (F691).
    const captioned = xyzImagery({ id: 'x', url: 'https://t/{z}/{x}/{y}.jpg', blankTile: '#cccccc', blankShare: 0.9 });
    expect(captioned.blankTile).toEqual({ rgb: [204, 204, 204], share: 0.9 });
    for (const blankShare of [0, 1.5, Number.NaN])
      expect(() => xyzImagery({ id: 'x', url: 'https://t/{z}/{x}/{y}.jpg', blankTile: '#cccccc', blankShare })).toThrow(
        /blankShare/,
      );
  });

  it('keys the sea of an area with keySea alone: the source transparent, every tile with the land over it (KB-329)', () => {
    const world: [number, number][] = [
      [-180, -85],
      [180, -85],
      [180, 85],
      [-180, 85],
      [-180, -85],
    ];
    const island: [number, number][] = [
      [10, 46],
      [16, 46],
      [16, 49],
      [10, 49],
      [10, 46],
    ];
    const source = xyzImagery({
      id: 'package',
      url: 'https://t/{z}/{x}/{y}.jpg',
      area: { polygons: [[world]], keySea: { land: [[island]], featherMeters: 4000 } },
    });
    expect(source.transparent).toBe(true);
    // Level 10: x = 540 straddles the island's western edge, x = 600 lies at sea.
    expect(source.tileMask?.(tile(10, 540, 354))?.sea?.ringEnds.length).toBe(1);
    expect(source.tileMask?.(tile(10, 600, 354))?.sea?.ringEnds.length).toBe(0);
  });
});
