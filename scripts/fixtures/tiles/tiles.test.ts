import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeTilePng, fixturePosition, renderTile, tileExists, worldColor } from './generate.ts';
import { FixtureServer, type RequestRecord } from './server.ts';

describe('fixture tiles', () => {
  it('keep every channel at 40 or more and alpha opaque, in every pattern', () => {
    for (const pattern of ['world', 'levels', 'border'] as const) {
      const rgba = renderTile({ pattern, scheme: 'mercator', level: 3, x: 4, y: 2, sizePx: 64 });
      for (let k = 0; k < rgba.length; k += 4) {
        expect(Math.min(rgba[k] ?? 0, rgba[k + 1] ?? 0, rgba[k + 2] ?? 0)).toBeGreaterThanOrEqual(40);
        expect(rgba[k + 3]).toBe(255);
      }
    }
  });

  it('place pixels like the tiling schemes and meet at shared edges', () => {
    const mercator = fixturePosition({ pattern: 'world', scheme: 'mercator', level: 1, x: 1, y: 0 }, 0, 1);
    expect([mercator.lonRad, mercator.latRad]).toEqual([0, 0]);
    const geographic = fixturePosition({ pattern: 'world', scheme: 'geographic', level: 0, x: 1, y: 0 }, 0, 0);
    expect([geographic.lonRad, geographic.latRad]).toEqual([0, Math.PI / 2]);
    // The world field is continuous: the last column of a tile and the first of its east neighbor nearly match.
    const west = fixturePosition({ pattern: 'world', scheme: 'mercator', level: 5, x: 10, y: 9 }, 1, 0.5);
    const east = fixturePosition({ pattern: 'world', scheme: 'mercator', level: 5, x: 11, y: 9 }, 0, 0.5);
    expect(worldColor(west.lonRad, west.latRad)).toEqual(worldColor(east.lonRad, east.latRad));
  });

  it('exist only inside their pyramid', () => {
    expect(tileExists({ pattern: 'world', scheme: 'mercator', level: 2, x: 3, y: 3 })).toBe(true);
    expect(tileExists({ pattern: 'world', scheme: 'mercator', level: 2, x: 4, y: 0 })).toBe(false);
    expect(tileExists({ pattern: 'world', scheme: 'geographic', level: 2, x: 7, y: 3 })).toBe(true);
    expect(tileExists({ pattern: 'world', scheme: 'geographic', level: 2, x: 7, y: 4 })).toBe(false);
  });

  it('encode as PNG of the requested size', () => {
    const png = PNG.sync.read(
      encodeTilePng({ pattern: 'levels', scheme: 'geographic', level: 1, x: 2, y: 1, sizePx: 32 }),
    );
    expect([png.width, png.height]).toEqual([32, 32]);
  });
});

describe('fixture tile server', () => {
  let server: Server;
  let base = '';
  let clock = 0;

  beforeAll(async () => {
    const fixtures = new FixtureServer(() => clock++);
    server = createServer((req, res) => fixtures.middleware(req, res, () => res.writeHead(418).end()));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const rules = (session: string, list: unknown): Promise<Response> =>
    fetch(`${base}/_fixture/${session}/rules`, { method: 'POST', body: JSON.stringify(list) });
  const log = async (session: string): Promise<RequestRecord[]> =>
    (await fetch(`${base}/_fixture/${session}/log`)).json() as Promise<RequestRecord[]>;

  it('serves tiles, 404s outside the pyramid, and leaves other paths to the next handler', async () => {
    const tile = await fetch(`${base}/fixture-tiles/a/world/mercator/3/1/2.png`);
    expect(tile.status).toBe(200);
    expect(tile.headers.get('content-type')).toBe('image/png');
    expect(PNG.sync.read(Buffer.from(await tile.arrayBuffer())).width).toBe(256);
    expect((await fetch(`${base}/fixture-tiles/a/world/mercator/3/8/2.png`)).status).toBe(404);
    expect((await fetch(`${base}/fixture-tiles/a/nothing/mercator/3/1/2.png`)).status).toBe(404);
    expect((await fetch(`${base}/elsewhere`)).status).toBe(418);
    expect((await log('a')).map((r) => r.status)).toEqual([200, 404, 404]);
  });

  it('applies fault rules per session: status N times, truncation, random bytes, content type, latency', async () => {
    expect(
      (
        await rules('b', [
          { minLevel: 5, maxLevel: 5, status: 503, failTimes: 1, retryAfterS: 2 },
          { minLevel: 6, maxLevel: 6, truncateBytes: 100 },
          { source: 'border', randomBytes: 64, contentType: 'image/jpeg' },
          { xRange: [0, 0], yRange: [0, 0], latencyMs: 30 },
        ])
      ).status,
    ).toBe(204);
    const first = await fetch(`${base}/fixture-tiles/b/world/mercator/5/1/1.png`);
    expect([first.status, first.headers.get('retry-after')]).toEqual([503, '2']);
    expect((await fetch(`${base}/fixture-tiles/b/world/mercator/5/1/1.png`)).status).toBe(200);
    expect((await (await fetch(`${base}/fixture-tiles/b/world/mercator/6/1/1.png`)).arrayBuffer()).byteLength).toBe(
      100,
    );
    const random = await fetch(`${base}/fixture-tiles/b/border/mercator/1/1/1.png`);
    expect([random.headers.get('content-type'), (await random.arrayBuffer()).byteLength]).toEqual(['image/jpeg', 64]);
    const started = Date.now();
    await fetch(`${base}/fixture-tiles/b/world/mercator/2/0/0.png`);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    // Another session is unaffected.
    expect((await fetch(`${base}/fixture-tiles/c/world/mercator/5/1/1.png`)).status).toBe(200);
    expect((await rules('b', { not: 'a list' })).status).toBe(400);
  });

  it('logs requests a client abandons, and resets a session', async () => {
    await rules('d', [{ hang: true }]);
    const controller = new AbortController();
    const pending = fetch(`${base}/fixture-tiles/d/world/mercator/1/0/0.png`, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await expect(pending).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await log('d'))[0]).toMatchObject({ level: 1, aborted: true });
    expect((await fetch(`${base}/_fixture/d`, { method: 'DELETE' })).status).toBe(204);
    expect(await log('d')).toEqual([]);
  });
});
