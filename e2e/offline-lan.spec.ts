// Offline mode 1 with the Docker LAN server (F550, offline track): packages/offline/lan-server/lan-server.sh serves the
// playground's production build, its engine assets, an offline package and a static tile folder; the browser reaches
// only that server. Needs Docker and `npm run build`.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { canvasImage, emptyPixelsInside, silhouetteRadiusPx, waitForIdle } from './support/globe.ts';
import { emptyPixels, openHarness, startHarness } from './support/offline.ts';

const PORT = 8091;
const LAN = `http://localhost:${PORT}`;
const SCRIPT = 'packages/offline/lan-server/lan-server.sh';
const NAME = 'vibeglobe-lan-e2e';
const ROME = { westDeg: 11.5, southDeg: 41.2, eastDeg: 13.5, northDeg: 42.6 };

let root = '';

/** Lets the page reach only the LAN server (and, for the harness page, the dev server that serves its code). */
async function onlyLan(page: Page, alsoAllowed: string[] = []): Promise<string[]> {
  const blocked: string[] = [];
  await page.route('**/*', (route) => {
    const origin = new URL(route.request().url()).origin;
    if (origin === LAN || alsoAllowed.includes(origin)) return route.continue();
    blocked.push(route.request().url());
    return route.abort('internetdisconnected');
  });
  return blocked;
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  root = mkdtempSync(join(tmpdir(), 'vibeglobe-lan-'));
  // The fixture content: a static tile folder of the world pattern (levels 0–6 around Rome) and a Rome package.
  const page = await browser.newPage({ baseURL: `http://localhost:${process.env['PLAYGROUND_PORT'] ?? 5173}` });
  for (let z = 0; z <= 6; z++) {
    const n = 2 ** z;
    const x0 = Math.floor(((ROME.westDeg + 180) / 360) * n);
    const x1 = Math.floor(((ROME.eastDeg + 180) / 360) * n);
    for (let x = Math.max(0, x0 - 1); x <= Math.min(n - 1, x1 + 1); x++)
      for (let y = 0; y < n; y++) {
        const latTop = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
        const latBottom = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI;
        if (z > 2 && (latBottom > ROME.northDeg + 6 || latTop < ROME.southDeg - 6)) continue;
        const response = await page.request.get(`/fixture-tiles/lan/world/mercator/${z}/${x}/${y}.png`);
        const dir = join(root, 'tiles', 'fixture-tiles', 'lan', 'world', 'mercator', String(z), String(x));
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, `${y}.png`), await response.body());
      }
  }
  await openHarness(page);
  await startHarness(page, { sources: [{ id: 'world', pattern: 'world', session: 'lan-build' }], view: {} });
  const built = await page.evaluate(() =>
    window.offlineHarness?.buildFixture({
      id: 'rome',
      version: '1',
      sourceId: 'world',
      pattern: 'patches',
      session: 'lan-package',
      bounds: { westDeg: 11.5, southDeg: 41.2, eastDeg: 13.5, northDeg: 42.6 },
      minLevel: 0,
      maxLevel: 8,
    }),
  );
  await page.close();
  if (!built) throw new Error('no fixture package');
  mkdirSync(join(root, 'packages', 'rome'), { recursive: true });
  writeFileSync(join(root, 'packages', 'rome', built.path), Buffer.from(built.base64, 'base64'));
  writeFileSync(join(root, 'packages', 'rome', 'manifest.json'), JSON.stringify(built.manifest));
  // The one command of the LAN server, as a user runs it.
  execFileSync(
    SCRIPT,
    [
      '--packages',
      join(root, 'packages'),
      '--tiles',
      join(root, 'tiles'),
      '--port',
      String(PORT),
      '--name',
      NAME,
      '--detach',
    ],
    { stdio: 'inherit' },
  );
  await expect.poll(async () => (await fetch(`${LAN}/`).catch(() => undefined))?.status, { timeout: 30_000 }).toBe(200);
});

test.afterAll(() => {
  execFileSync('docker', ['rm', '--force', NAME], { stdio: 'ignore' });
  rmSync(root, { recursive: true, force: true });
});

test('the LAN server answers with the MIME types, CORS, cache headers and range requests the engine needs (F550)', async () => {
  const range = await fetch(`${LAN}/packages/rome/rome.pmtiles`, { headers: { Range: 'bytes=0-126' } });
  expect(range.status).toBe(206);
  expect(range.headers.get('content-type')).toBe('application/vnd.pmtiles');
  expect(range.headers.get('content-range')).toMatch(/^bytes 0-126\/\d+$/);
  expect(range.headers.get('access-control-allow-origin')).toBe('*');
  expect(range.headers.get('access-control-allow-headers')).toContain('Range');
  expect(range.headers.get('access-control-expose-headers')).toContain('Content-Range');
  expect(range.headers.get('etag')).toBeTruthy();
  expect(new Uint8Array(await range.arrayBuffer()).length).toBe(127);
  const manifest = await fetch(`${LAN}/packages/rome/manifest.json`);
  expect(manifest.headers.get('content-type')).toContain('application/json');
  const tile = await fetch(`${LAN}/tiles/fixture-tiles/lan/world/mercator/0/0/0.png`);
  expect(tile.headers.get('content-type')).toBe('image/png');
  expect(tile.headers.get('cache-control')).toContain('max-age=86400');
  expect((await fetch(`${LAN}/tiles/fixture-tiles/lan/world/mercator/9/0/0.png`)).status).toBe(404);
  const page = await fetch(`${LAN}/`);
  expect(page.headers.get('content-type')).toContain('text/html');
  // Engine assets of the build: the worker program, the Basis transcoder and the pinned base image.
  const assets = readdirSync('apps/playground/dist/assets');
  for (const [pattern, type] of [
    [/^vibeglobe-worker-.*\.js$/, 'application/javascript'],
    [/^vibeglobe-basis-.*\.wasm$/, 'application/wasm'],
  ] as const) {
    const file = assets.find((name) => pattern.test(name));
    const response = await fetch(`${LAN}/assets/${file ?? 'missing'}`);
    expect(response.status, String(pattern)).toBe(200);
    expect(response.headers.get('content-type')).toContain(type);
    expect(response.headers.get('cache-control')).toContain('immutable');
  }
  const base = await fetch(`${LAN}/imagery/natural-earth-4096.jpg`);
  expect(base.headers.get('content-type')).toBe('image/jpeg');
  expect(base.headers.get('access-control-allow-origin')).toBe('*');
});

test('the playground build from the LAN server navigates its static tile folder with no other host reachable (F550)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const blocked = await onlyLan(page);
  await page.goto(`${LAN}/?imagery=world&session=lan&tileBase=${LAN}/tiles/&imageryMax=6&lon=12.5&lat=41.9&zoom=5`);
  await page.waitForFunction(() => window.vibeglobePlayground !== undefined, undefined, { timeout: 60_000 });
  await page.evaluate(async () => window.vibeglobePlayground?.globe.ready);
  for (const zoom of [5, 6, 7]) {
    await page.evaluate(
      (z) => window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: z }),
      zoom,
    );
    await waitForIdle(page);
    expect(emptyPixelsInside(await canvasImage(page), await silhouetteRadiusPx(page))).toBe(0);
  }
  expect(blocked).toEqual([]);
});

test('offline mode 1: an offline package read in place from the LAN server, health checks only to the LAN (F550)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const dev = `http://localhost:${process.env['PLAYGROUND_PORT'] ?? 5173}`;
  const requests: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith(dev)) requests.push(request.url());
  });
  const blocked = await onlyLan(page, [dev]);
  await openHarness(page);
  await startHarness(page, {
    network: 'hybrid',
    sources: [{ id: 'world', url: `${LAN}/tiles/fixture-tiles/lan/world/mercator/{z}/{x}/{y}.png`, maxLevel: 6 }],
    served: [`${LAN}/packages/rome/manifest.json`],
    view: { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 7 },
  });
  expect(await emptyPixels(page)).toBe(0);
  const tiers = await page.evaluate(() => window.offlineHarness?.served.map((e) => e.tier) ?? []);
  expect(tiers).toContain('package');
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((url) => url.startsWith(LAN))).toBe(true);
  expect(blocked).toEqual([]);
});
