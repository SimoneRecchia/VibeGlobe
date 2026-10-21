import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * F100: the engine runs under a strict Content Security Policy, from the playground's production build (served by
 * `vite preview`, as consumers ship it): no eval or generated code, workers only from the configured asset location.
 */

const PREVIEW = `http://localhost:${process.env['PLAYGROUND_PREVIEW_PORT'] ?? 5176}`;
const DIST = join(import.meta.dirname, '..', 'apps', 'playground', 'dist');

/** Serves every document of the page with `policy` and records the violations the page reports. */
async function withPolicy(page: Page, policy: string): Promise<string[]> {
  const violations: string[] = [];
  await page.exposeFunction('reportViolation', (text: string) => violations.push(text));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      (window as unknown as { reportViolation: (text: string) => void }).reportViolation(
        `${event.violatedDirective} ${event.blockedURI}`,
      );
    });
  });
  page.on('console', (message) => {
    if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
  });
  await page.route(`${PREVIEW}/**`, async (route) => {
    if (route.request().resourceType() !== 'document') return route.fallback();
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': policy } });
  });
  return violations;
}

/** Opens the production playground streaming fixture imagery and waits until the center shows its own level. */
async function streamImagery(page: Page, query: string): Promise<void> {
  const session = `csp${Date.now().toString(36)}`;
  await page.goto(`${PREVIEW}/?imagery=levels&session=${session}&lon=12.5&lat=41.9&zoom=7&${query}`);
  await page.waitForFunction(() => window.vibeglobePlayground !== undefined);
  await page.evaluate(async () => window.vibeglobePlayground?.globe.ready);
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (window.vibeglobePlayground?.globe.surfaceTiles() ?? []).some(
            (tile) => tile.imageryLevel !== null && tile.imageryLevel === tile.level,
          ),
        ),
      { timeout: 60_000 },
    )
    .toBe(true);
}

/** The policy of the step: nothing evaluated, scripts and workers only from the page's origin (or `workers`). */
const policy = (workers = "'self'"): string =>
  [
    "default-src 'self'",
    "script-src 'self'",
    `worker-src ${workers}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
  ].join('; ');

test('the engine starts and streams imagery under a strict Content Security Policy (F100)', async ({ page }) => {
  test.setTimeout(120_000);
  const violations = await withPolicy(page, policy());
  await streamImagery(page, '');
  expect(page.workers().map((worker) => new URL(worker.url()).origin)).toContain(PREVIEW);
  expect(violations).toEqual([]);
});

test('workers and assets load from a configured asset base URL, the only place workers may come from (F100)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const worker = readdirSync(join(DIST, 'assets')).find((file) => /^vibeglobe-worker-.*\.js$/.test(file));
  expect(worker).toBeDefined();
  const violations = await withPolicy(page, policy(`${PREVIEW}/engine-assets/`));
  const served: string[] = [];
  // The host serves the engine's files under /engine-assets/: the worker program and the base image.
  await page.route(`${PREVIEW}/engine-assets/**`, async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop() ?? '';
    served.push(name);
    const file = name === 'vibeglobe-worker.js' ? join(DIST, 'assets', worker ?? '') : join(DIST, 'imagery', name);
    await route.fulfill({
      body: readFileSync(file),
      contentType: name.endsWith('.js') ? 'text/javascript' : 'image/jpeg',
    });
  });
  await streamImagery(page, 'assets=/engine-assets/');
  expect(served).toEqual(expect.arrayContaining(['vibeglobe-worker.js', 'natural-earth-4096.jpg']));
  expect(page.workers().map((w) => new URL(w.url()).pathname)).toContain('/engine-assets/vibeglobe-worker.js');
  expect(violations).toEqual([]);
});

test('the built bundles contain no eval, no Function constructor and no blob-generated code (F100)', () => {
  const bundles = [
    join(DIST, 'assets'),
    ...['core', 'renderer', 'sources', 'worker', 'controls', 'ui'].map((name) =>
      join(import.meta.dirname, '..', 'packages', name, 'dist'),
    ),
  ];
  const offenders: string[] = [];
  for (const directory of bundles) {
    for (const file of readdirSync(directory, { recursive: true }).map(String)) {
      if (!file.endsWith('.js')) continue;
      const code = readFileSync(join(directory, file), 'utf8');
      // Blob-generated code needs createObjectURL; the worker package only mentions blob: URLs to refuse them.
      if (/\beval\s*\(|new\s+Function\s*\(|\bFunction\s*\(\s*['"`]|createObjectURL/.test(code))
        offenders.push(join(directory, file));
    }
  }
  expect(offenders).toEqual([]);
});
