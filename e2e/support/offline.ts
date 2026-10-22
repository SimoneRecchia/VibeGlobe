// Node-side helpers of the offline track's end-to-end tests: open the harness page (e2e/support/offline.html), start
// a configuration, record tile requests, read storage.
import { resolve } from 'node:path';
import type { Page, Request } from '@playwright/test';
import type { HarnessConfig } from './offline-page.ts';
import { canvasImage, emptyPixelsInside, silhouetteRadiusPx, waitForIdle } from './globe.ts';

export type { HarnessConfig };

const PAGE = `/@fs${resolve('e2e/support/offline.html')}`;

/** Opens the harness page with empty browser storage and waits until its module ran. */
export async function openHarness(page: Page, options: { keepStorage?: boolean } = {}): Promise<void> {
  await page.goto(PAGE);
  await page.waitForFunction(() => window.offlineHarness !== undefined, undefined, { timeout: 60_000 });
  if (!options.keepStorage) await clearStorage(page);
}

/** Deletes the engine's database and its eviction bookkeeping. */
async function clearStorage(page: Page): Promise<void> {
  await page.evaluate(async () => {
    window.offlineHarness?.stop();
    localStorage.clear();
    await new Promise<void>((done) => {
      const request = indexedDB.deleteDatabase('vibeglobe-offline');
      request.onsuccess = request.onerror = request.onblocked = () => done();
    });
  });
}

/** Starts the harness with a configuration and waits for the globe's first frame. */
export async function startHarness(page: Page, config: HarnessConfig): Promise<void> {
  await page.evaluate((c) => window.offlineHarness?.start(c), config);
}

/**
 * Serves the fixture tiles with the cache headers `headersFor` returns for each path (the fixture server itself sends
 * `no-store`, which the engine never persists). `undefined` keeps the original answer.
 */
export async function tileHeaders(
  page: Page,
  headersFor: (
    path: string,
    request: Request,
  ) => Record<string, string> | { status: number; headers?: Record<string, string> } | undefined,
): Promise<void> {
  await page.route('**/fixture-tiles/**', async (route) => {
    const request = route.request();
    const custom = headersFor(new URL(request.url()).pathname, request);
    if (custom === undefined) return route.continue();
    if ('status' in custom && typeof custom.status === 'number')
      return route.fulfill({
        status: custom.status,
        headers: (custom.headers as Record<string, string>) ?? {},
        body: '',
      });
    const response = await route.fetch();
    const headers = { ...response.headers() };
    delete headers['cache-control'];
    return route.fulfill({ response, headers: { ...headers, ...(custom as Record<string, string>) } });
  });
}

/** Records the tile requests (fixture tiles) the page makes, by path. */
export function recordTileRequests(page: Page): string[] {
  const paths: string[] = [];
  page.on('request', (request: Request) => {
    const url = new URL(request.url());
    if (url.pathname.includes('/fixture-tiles/')) paths.push(url.pathname);
  });
  return paths;
}

/** The pixels without imagery inside the globe after it went idle (must be 0: no black area). */
export async function emptyPixels(page: Page): Promise<number> {
  await waitForIdle(page);
  return emptyPixelsInside(await canvasImage(page), await silhouetteRadiusPx(page));
}

/** Where the tiles served since the globe started came from, per tier. */
export async function servedTiers(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const counts: Record<string, number> = {};
    for (const event of window.offlineHarness?.served ?? []) counts[event.tier] = (counts[event.tier] ?? 0) + 1;
    return counts;
  });
}

/** Keys of the tiles in the persistent cache (read directly from IndexedDB). */
export async function storedTileKeys(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((done, fail) => {
        const open = indexedDB.open('vibeglobe-offline');
        open.onerror = () => fail(new Error('cannot open the database'));
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('tiles')) {
            db.close();
            done([]);
            return;
          }
          const request = db.transaction('tiles').objectStore('tiles').getAllKeys();
          request.onsuccess = () => {
            db.close();
            done((request.result as string[]).sort());
          };
        };
      }),
  );
}

/** The tiles in the persistent cache with their ETag and size (read directly from IndexedDB). */
export async function storedTiles(page: Page): Promise<{ key: string; etag: string | undefined; bytes: number }[]> {
  return page.evaluate(
    () =>
      new Promise<{ key: string; etag: string | undefined; bytes: number }[]>((done, fail) => {
        const open = indexedDB.open('vibeglobe-offline');
        open.onerror = () => fail(new Error('cannot open the database'));
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('tiles')) {
            db.close();
            done([]);
            return;
          }
          const out: { key: string; etag: string | undefined; bytes: number }[] = [];
          const request = db.transaction('tiles').objectStore('tiles').openCursor();
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) {
              db.close();
              done(out);
              return;
            }
            const value = cursor.value as { etag?: string; bytes: ArrayBuffer };
            out.push({ key: String(cursor.key), etag: value.etag, bytes: value.bytes.byteLength });
            cursor.continue();
          };
        };
      }),
  );
}

/** Moves the camera and waits until the view is complete. */
export async function viewAt(page: Page, longitudeDeg: number, latitudeDeg: number, zoom: number): Promise<number> {
  await page.evaluate(
    (v) => window.offlineHarness?.globe?.jumpTo({ longitudeDeg: v[0], latitudeDeg: v[1], zoom: v[2] }),
    [longitudeDeg, latitudeDeg, zoom] as const,
  );
  return emptyPixels(page);
}

/** The column of a fixture tile path (`…/{z}/{x}/{y}.png`). */
export function tileColumn(path: string): number {
  return Number(/\/(\d+)\/\d+\.png$/.exec(path)?.[1] ?? NaN);
}

/** A package served to the page under `/offline-fixtures/` (offline mode 1's LAN server, as a route). */
export interface PackageServer {
  /** Files by path below `/offline-fixtures/`; set or replace them at any time. */
  readonly files: Map<string, Buffer | string>;
  /** Every request with its Range header, oldest first. */
  readonly requests: { path: string; range: string | undefined }[];
}

/** Serves files with range requests under `/offline-fixtures/`. */
export async function servePackages(page: Page): Promise<PackageServer> {
  const server: PackageServer = { files: new Map(), requests: [] };
  await page.route('**/offline-fixtures/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/offline-fixtures\//, '');
    const range = request.headers()['range'];
    server.requests.push({ path, range });
    const body = server.files.get(path);
    if (body === undefined) return route.fulfill({ status: 404, body: 'not found' });
    if (typeof body === 'string') return route.fulfill({ status: 200, contentType: 'application/json', body });
    const match = /bytes=(\d+)-(\d+)/.exec(range ?? '');
    if (!match) return route.fulfill({ status: 200, contentType: 'application/octet-stream', body });
    const start = Number(match[1]);
    const end = Math.min(body.length - 1, Number(match[2]));
    return route.fulfill({
      status: 206,
      contentType: 'application/octet-stream',
      headers: { 'Content-Range': `bytes ${start}-${end}/${body.length}` },
      body: body.subarray(start, end + 1),
    });
  });
  return server;
}

/** Builds a fixture package in the page and puts its manifest and file on the package server. */
export async function publishFixture(
  page: Page,
  server: PackageServer,
  spec: Parameters<OfflineHarnessApi['buildFixture']>[0],
  edit?: (file: Buffer) => Buffer,
): Promise<{ manifestUrl: string; file: Buffer }> {
  const built = await page.evaluate((s) => window.offlineHarness?.buildFixture(s), spec);
  if (!built) throw new Error('no harness');
  const file = Buffer.from(built.base64, 'base64');
  server.files.set(`${spec.id}/${built.path}`, edit ? edit(file) : file);
  server.files.set(`${spec.id}/manifest.json`, JSON.stringify(built.manifest));
  return { manifestUrl: `/offline-fixtures/${spec.id}/manifest.json`, file };
}

type OfflineHarnessApi = NonNullable<Window['offlineHarness']>;
