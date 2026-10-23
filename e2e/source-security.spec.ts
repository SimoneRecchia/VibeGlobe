// Transport security (M7): CORS-aware fetching (F251), per-source credentials sent only to their hosts and renewed
// when refused (F252), and secrets kept out of URLs, logs, traces and the debug overlay (F253).
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage, openGlobe, waitForIdle } from './support/globe.ts';
import { fixtureSession, requestLog } from './support/imagery.ts';

test.use({ viewport: { width: 320, height: 240 } });

/** The fixture server under another origin than the page (`localhost` and `127.0.0.1` are distinct origins). */
const OTHER_ORIGIN = 'http://127.0.0.1:5173/';

function blackPixels(image: PNG): number {
  let count = 0;
  for (let i = 0; i < image.data.length; i += 4)
    if ((image.data[i] ?? 0) < 20 && (image.data[i + 1] ?? 0) < 20 && (image.data[i + 2] ?? 0) < 20) count++;
  return count;
}

async function settle(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const stats = window.vibeglobePlayground?.globe.imageryStats();
          return stats ? stats.queued + stats.loading + stats.decoding + stats.uploadsPending : 1;
        }),
      { timeout: 60_000 },
    )
    .toBe(0);
  await waitForIdle(page);
}

async function setRules(page: Page, session: string, rules: unknown[]): Promise<void> {
  expect((await page.request.post(`/_fixture/${session}/rules`, { data: JSON.stringify(rules) })).status()).toBe(204);
}

async function creditTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => (window.vibeglobePlayground?.globe.credits() ?? []).map((c) => c.text));
}

/** Every console message of the page. */
function consoleOf(page: Page): string[] {
  const messages: string[] = [];
  page.on('console', (message) => messages.push(`${message.type()}: ${message.text()}`));
  return messages;
}

for (const backend of ['webgpu', 'webgl2'] as const) {
  test(`tiles from another origin with CORS headers render on ${backend} (F251)`, async ({ page }) => {
    const session = await fixtureSession(page);
    await openGlobe(
      page,
      `backend=${backend}&imagery=smooth&overlays=patches:0.5&overlayHosts=${OTHER_ORIGIN}&session=${session}&lon=12.5&lat=41.9&zoom=6`,
    );
    await settle(page);
    const log = (await requestLog(page, session)).filter((r) => r.source === 'patches');
    expect(log.length).toBeGreaterThan(0);
    expect(log.every((r) => r.host === '127.0.0.1:5173' && r.status === 200)).toBe(true);
    expect(await creditTexts(page)).toContain('Fixture patches');
    expect(blackPixels(await canvasImage(page))).toBe(0);
  });
}

test('a source without CORS headers logs one error naming it, its tiles count as unavailable and the view keeps rendering (F251)', async ({
  page,
}) => {
  const messages = consoleOf(page);
  const session = await fixtureSession(page);
  await setRules(page, session, [{ source: 'patches', noCors: true }]);
  await openGlobe(
    page,
    `backend=webgl2&imagery=smooth&overlays=patches:0.5&overlayHosts=${OTHER_ORIGIN}&session=${session}&lon=12.5&lat=41.9&zoom=6`,
  );
  await settle(page);
  const errors = messages.filter((m) => m.startsWith('error:') && m.includes('overlay-patches'));
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatch(/CORS/);
  expect(await creditTexts(page)).toEqual(['Fixture smooth']);
  expect(blackPixels(await canvasImage(page))).toBe(0);
  // Not retried: each refused tile was asked once (besides the engine's one no-cors probe that diagnoses it).
  const refused = (await requestLog(page, session)).filter((r) => r.source === 'patches' && r.fetchMode === 'cors');
  expect(refused.length).toBeGreaterThan(0);
  const keys = refused.map((r) => `${String(r.level)}/${String(r.x)}/${String(r.y)}`);
  expect(new Set(keys).size).toBe(keys.length);
});

for (const mode of ['include', 'omit'] as const) {
  test(`requests are sent with the source's credentials mode ${mode} (F251)`, async ({ page, context }) => {
    await context.addCookies([{ name: 'fixture', value: '1', url: OTHER_ORIGIN }]);
    const session = await fixtureSession(page);
    await openGlobe(
      page,
      `backend=webgl2&imagery=smooth&overlays=patches:0.5&overlayHosts=${OTHER_ORIGIN}&overlayCredentials=${mode}&session=${session}&lon=12.5&lat=41.9&zoom=6`,
    );
    await settle(page);
    const log = (await requestLog(page, session)).filter((r) => r.source === 'patches');
    expect(log.length).toBeGreaterThan(0);
    expect(log.every((r) => r.cookie === (mode === 'include'))).toBe(true);
  });
}

test('each source sends its own credentials only to its hosts, renews them when refused, and they never show (F252, F253)', async ({
  page,
}) => {
  const messages = consoleOf(page);
  const session = await fixtureSession(page);
  // The first overlay's server accepts only its renewed token: its first token is refused.
  await setRules(page, session, [{ source: 'patches', requireAuthorization: 'Bearer patches-2' }]);
  await openGlobe(
    page,
    `backend=webgl2&debug=1&imagery=smooth&overlays=patches:0.5,green:0.3&overlayHosts=,${OTHER_ORIGIN}&overlayAuth=1&session=${session}&lon=12.5&lat=41.9&zoom=6`,
  );
  await page.evaluate(() => window.vibeglobePlayground?.globe.diagnostics.startTrace());
  await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: 14, latitudeDeg: 42 }));
  await settle(page);
  const trace = JSON.stringify(await page.evaluate(() => window.vibeglobePlayground?.globe.diagnostics.stopTrace()));
  const log = await requestLog(page, session);
  const patches = log.filter((r) => r.source === 'patches');
  const green = log.filter((r) => r.source === 'green');
  const base = log.filter((r) => r.source === 'smooth');
  // Each header reached only its own source, on its own host.
  expect(patches.every((r) => r.authorization?.startsWith('Bearer patches-') && r.host === 'localhost:5173')).toBe(
    true,
  );
  expect(green.every((r) => r.authorization?.startsWith('Bearer green-') && r.host === '127.0.0.1:5173')).toBe(true);
  expect(base.every((r) => r.authorization === undefined)).toBe(true);
  // Refused with the first token, then retried with the renewed one.
  expect(patches.some((r) => r.status === 401 && r.authorization === 'Bearer patches-1')).toBe(true);
  expect(patches.some((r) => r.status === 200 && r.authorization === 'Bearer patches-2')).toBe(true);
  expect(blackPixels(await canvasImage(page))).toBe(0);
  // Header credentials never reach a URL, the logs, the trace or the debug overlay.
  const overlay = (await page.locator('.vibeglobe-debug-overlay').textContent()) ?? '';
  expect(log.every((r) => !/Bearer|patches-\d|green-\d/.test(r.path))).toBe(true);
  for (const [where, text] of [
    ['console', messages.join('\n')],
    ['trace', trace],
    ['debug overlay', overlay],
  ] as const)
    expect(text, where).not.toMatch(/Bearer|patches-\d|green-\d/);
});

test('a key the provider requires in the URL is added at fetch time and appears in no log, trace, overlay or error (F253)', async ({
  page,
}) => {
  const messages = consoleOf(page);
  const session = await fixtureSession(page);
  // Some tiles fail, so that errors are logged with their URLs.
  await setRules(page, session, [{ source: 'patches', minLevel: 6, xRange: [34, 35], status: 500 }]);
  await openGlobe(
    page,
    `backend=webgl2&debug=1&imagery=smooth&overlays=patches:0.5&overlayKey=sk_fixture_123&session=${session}&lon=12.5&lat=41.9&zoom=6`,
  );
  await page.evaluate(() => window.vibeglobePlayground?.globe.diagnostics.startTrace());
  await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: 14, latitudeDeg: 42 }));
  await settle(page);
  const trace = JSON.stringify(await page.evaluate(() => window.vibeglobePlayground?.globe.diagnostics.stopTrace()));
  const patches = (await requestLog(page, session)).filter((r) => r.source === 'patches');
  // The key reached the server…
  expect(patches.length).toBeGreaterThan(0);
  expect(patches.every((r) => r.query?.includes('key=sk_fixture_123'))).toBe(true);
  expect(patches.some((r) => r.status === 500)).toBe(true);
  // …and nothing the engine logs, traces or shows.
  const overlay = (await page.locator('.vibeglobe-debug-overlay').textContent()) ?? '';
  expect(messages.some((m) => m.includes('overlay-patches'))).toBe(true);
  for (const [where, text] of [
    ['console', messages.join('\n')],
    ['trace', trace],
    ['debug overlay', overlay],
  ] as const)
    expect(text, where).not.toContain('sk_fixture_123');
});

test('the sources guide explains how to keep secrets out of URLs (F253)', () => {
  const guide = readFileSync(new URL('../docs/guides/sources.md', import.meta.url), 'utf8');
  expect(guide).toMatch(/## Keeping secrets out of URLs/);
  expect(guide).toMatch(/secretQuery/);
  expect(guide).toMatch(/redactUrl/);
});
