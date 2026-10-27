// The network simulation suite (F315) and the no-telemetry check (F316), M8 track B: the navigation scenario (zoom,
// pan, a flight) on fully offline, 400 kbps, flaky, high-latency and LAN-only links, with every loading feature on,
// recording every request the page makes. Small canvas, as the other offline specs on the software GPU.
import { expect, test, type Page, type Route } from '@playwright/test';
import { backoffViolations, type Attempt } from '../scripts/fixtures/network/links.ts';
import { nextFrame } from './support/globe.ts';
import {
  emptyPixels,
  emptyPixelsMoving,
  openHarness,
  publishFixture,
  servePackages,
  startHarness,
  tileHeaders,
} from './support/offline.ts';

test.use({ viewport: { width: 320, height: 240 } });
test.beforeEach(() => test.setTimeout(300_000));

const ROME = { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 8 };
const WORLD_BASE = {
  id: 'world-base',
  sourceId: 'world',
  pattern: 'world',
  bounds: { westDeg: -180, southDeg: -85, eastDeg: 180, northDeg: 85 },
  minLevel: 0,
  maxLevel: 3,
  version: '1',
};
const HEALTH = { minIntervalMs: 300, maxIntervalMs: 4000 };

/** A simulated link: what happens to each tile request of the online source. */
interface Link {
  readonly name: string;
  /** Delay before the answer, ms, from the body size. */
  delayMs(bytes: number): number;
  /** True to drop the request (reset). */
  drop(index: number): boolean;
}

const LINKS: readonly Link[] = [
  { name: 'fully offline', delayMs: () => 0, drop: () => true },
  { name: '400 kbps', delayMs: (bytes) => (bytes * 8) / 400, drop: () => false },
  // A fixed pattern of one request in five dropped (20 %), so a failure reproduces.
  { name: 'flaky', delayMs: () => 30, drop: (index) => index % 5 === 2 },
  { name: '500 ms latency', delayMs: () => 500, drop: () => false },
];

/** Zoom, pan and a flight; the most empty pixels any sampled frame showed once the base had loaded. */
async function navigate(page: Page): Promise<number> {
  let worst = 0;
  for (const view of [ROME, { ...ROME, zoom: 9 }, { ...ROME, longitudeDeg: 12.8, zoom: 9 }]) {
    await page.evaluate((v) => window.offlineHarness?.globe?.jumpTo(v), view);
    await nextFrame(page);
    worst = Math.max(worst, await emptyPixelsMoving(page));
  }
  await page.evaluate(() => {
    void window.offlineHarness?.globe?.flyTo({ longitudeDeg: 2.35, latitudeDeg: 48.85, zoom: 8 }, { durationMs: 3000 });
  });
  for (let k = 0; k < 10; k++) {
    await nextFrame(page);
    worst = Math.max(worst, await emptyPixelsMoving(page));
  }
  await page.waitForTimeout(3500);
  return Math.max(worst, await emptyPixelsMoving(page));
}

/** Starts the harness over a world base package with the online source behind `link`; returns each tile's attempts. */
async function startOn(page: Page, link: Link, session: string): Promise<Record<string, Attempt[]>> {
  await openHarness(page);
  await startHarness(page, { sources: [{ id: 'world', pattern: 'world', session }], view: ROME });
  await page.evaluate((s) => window.offlineHarness?.installFixture(s), { ...WORLD_BASE, session });
  const attempts: Record<string, Attempt[]> = {};
  let index = 0;
  await page.route(`**/fixture-tiles/${session}/**`, async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    // Health checks probe the source's root tile (0/0/0); the world-base package serves that tile, so the engine never
    // asks the network for it as a tile: each request for it is a health check.
    const probe = path.endsWith('/0/0/0.png');
    const key = probe ? `health check ${path}` : path;
    const startMs = Date.now();
    // The globe's frame when the handler runs: never earlier than the request's own frame.
    const frame = await page
      .evaluate(() => window.offlineHarness?.globe?.frameNumber ?? 0)
      .catch(() => Number.MAX_SAFE_INTEGER);
    const attempt = { startMs, frame, failed: false };
    (attempts[key] ??= []).push(attempt);
    if (link.drop(index++)) {
      attempt.failed = true;
      return route.abort('connectionreset');
    }
    try {
      const response = await route.fetch();
      const body = await response.body();
      await new Promise((resolve) => setTimeout(resolve, link.delayMs(body.length)));
      await route.fulfill({ response, body });
    } catch {
      // The engine cancelled the request (or the page closed) while the link was still delivering it.
    }
  });
  await startHarness(page, {
    sources: [{ id: 'world', pattern: 'world', session }],
    view: ROME,
    healthChecks: HEALTH,
  });
  // The base has loaded: the package's levels under the first view. (On a dead link the engine keeps asking for the
  // finer tiles, so it never goes idle: poll the frame instead.)
  await expect.poll(() => emptyPixelsMoving(page), { timeout: 60_000 }).toBe(0);
  return attempts;
}

/**
 * Bounded retries with backoff, as track F's suite judges them (ADR 0151): at most six attempts in a row of failures,
 * each retry in a later frame than its failure, health checks never closer together than their minimum interval. The
 * engine's retries wait a random delay under a doubling ceiling (ADR 0007), so single waits may shrink.
 */
function expectBackoff(attempts: Record<string, Attempt[]>): void {
  expect(
    backoffViolations(attempts, {
      maxAttempts: 6,
      healthMinIntervalMs: HEALTH.minIntervalMs,
      isHealthCheck: (key) => key.startsWith('health check'),
    }),
  ).toEqual([]);
}

for (const link of LINKS)
  test(`the navigation scenario on a ${link.name} link: no black pixel, no endless retry, backoff (F315)`, async ({
    page,
  }) => {
    const attempts = await startOn(page, link, `f315-${link.name.replace(/\W+/g, '-')}`);
    expect(await navigate(page)).toBe(0);
    expectBackoff(attempts);
  });

test('the navigation scenario in LAN-only mode: packages and tiles from the LAN server, nothing else (F315)', async ({
  page,
}) => {
  await openHarness(page);
  const lan = await servePackages(page);
  await startHarness(page, { sources: [{ id: 'world', pattern: 'world', session: 'f315-lan' }], view: ROME });
  const base = await publishFixture(page, lan, { ...WORLD_BASE, session: 'f315-lan' });
  const elsewhere: string[] = [];
  await page.route(
    (url) => url.hostname !== 'localhost',
    (route) => {
      elsewhere.push(route.request().url());
      return route.abort('internetdisconnected');
    },
  );
  await startHarness(page, {
    sources: [{ id: 'world', pattern: 'world', session: 'f315-lan' }],
    served: [base.manifestUrl],
    view: ROME,
    healthChecks: HEALTH,
  });
  expect(await emptyPixels(page)).toBe(0);
  expect(await navigate(page)).toBe(0);
  expect(elsewhere).toEqual([]);
});

test('no telemetry: every request goes to a configured source, package, health check or asset, and carries only what a tile needs (F316)', async ({
  page,
}) => {
  const requests: { url: URL; method: string; body: string | null; headers: Record<string, string> }[] = [];
  page.on('request', (request) =>
    requests.push({
      url: new URL(request.url()),
      method: request.method(),
      body: request.postData(),
      headers: request.headers(),
    }),
  );
  await openHarness(page);
  await tileHeaders(page, () => ({ 'Cache-Control': 'max-age=86400' }));
  const lan = await servePackages(page);
  await startHarness(page, { sources: [{ id: 'world', pattern: 'world', session: 'f316' }], view: ROME });
  const base = await publishFixture(page, lan, { ...WORLD_BASE, session: 'f316' });
  await page.evaluate((s) => window.offlineHarness?.installFixture(s), {
    ...WORLD_BASE,
    id: 'stored',
    session: 'f316',
  });
  const from = requests.length;
  // Every loading feature on (the default), every tier in use.
  await startHarness(page, {
    sources: [
      { id: 'world', pattern: 'world', session: 'f316' },
      { id: 'roads', pattern: 'levels', session: 'f316-roads', minLevel: 5 },
    ],
    served: [base.manifestUrl],
    view: ROME,
    healthChecks: HEALTH,
  });
  expect(await navigate(page)).toBe(0);
  await page.evaluate(() => window.offlineHarness?.restartGlobe());
  expect(await emptyPixels(page)).toBe(0);

  const origin = new URL(page.url()).origin;
  const tile = /^\/fixture-tiles\/(f316|f316-roads)\/(world|levels)\/mercator\/\d+\/\d+\/\d+\.png$/;
  const purposes = requests.slice(from).map(({ url, method, body, headers }) => {
    if (url.origin !== origin) return `foreign host: ${url.href}`;
    if (body !== null && body.length > 0) return `request body: ${method} ${url.pathname}`;
    if (headers['cookie'] !== undefined) return `cookie sent: ${url.pathname}`;
    if (tile.test(url.pathname)) return url.search === '' ? 'tile or health check' : `tile with a query: ${url.href}`;
    if (url.pathname.startsWith('/offline-fixtures/world-base/')) return 'package';
    // The engine's own code, workers and assets (the application hosts them, ADR 0015).
    if (
      /^\/(@fs|@vite|@id|node_modules|imagery)\//.test(url.pathname) ||
      /\.(ts|js|mjs|wasm|jpg|css)$/.test(url.pathname)
    )
      return 'asset';
    return `unexpected: ${method} ${url.pathname}${url.search}`;
  });
  expect(purposes.filter((p) => !['tile or health check', 'package', 'asset'].includes(p))).toEqual([]);
  expect(purposes).toContain('tile or health check');
  expect(purposes).toContain('package');
});
