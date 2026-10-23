// Google's logo and credits stay visible and uncovered (F259) with every UI control, at every viewport size, whatever
// page CSS, scripts or covering elements try.
import { expect, test, type Page, type Route } from '@playwright/test';
import { GOOGLE_FIXTURE_KEY, googleFixture } from '../packages/sources/src/__fixtures__/google-server.ts';
import { mountSource, openSources, settledSourceFrame, tilePng } from './support/sources.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST',
};

/** Answers a routed request from a fixture `fetch`, adding CORS headers. */
async function fulfillFrom(route: Route, fixture: typeof fetch): Promise<void> {
  const request = route.request();
  if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  const body = request.postData();
  const response = await fixture(request.url(), { method: request.method(), ...(body === null ? {} : { body }) });
  return route.fulfill({
    status: response.status,
    headers: { ...Object.fromEntries(response.headers), ...CORS },
    body: Buffer.from(await response.arrayBuffer()),
  });
}

/** A stand-in logo image for the fixture: 60 × 18 px. */
const LOGO =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="18"><rect width="60" height="18" fill="#4285f4"/></svg>',
  );

/** The credit items and the Google logo, each with whether it is fully visible and the topmost element at its corners. */
async function creditVisibility(page: Page): Promise<{ text: string; logo: boolean; uncovered: boolean }[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.vg-source-test .vg-credits .vg-credit')].map((item) => {
      const box = item.getBoundingClientRect();
      const inside = box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight;
      const points = [
        [box.left + 1, box.top + 1],
        [box.right - 1, box.top + 1],
        [box.left + 1, box.bottom - 1],
        [box.right - 1, box.bottom - 1],
        [box.left + box.width / 2, box.top + box.height / 2],
      ];
      const style = getComputedStyle(item.parentElement ?? item);
      const shown = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
      return {
        text: item.textContent ?? '',
        logo: item.querySelector('img') !== null,
        uncovered:
          inside &&
          shown &&
          box.width > 0 &&
          points.every(([x = 0, y = 0]) => {
            const top = document.elementFromPoint(x, y);
            return top !== null && item.contains(top);
          }),
      };
    }),
  );
}

for (const viewport of [
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'tablet landscape', width: 1024, height: 768 },
  { name: 'tablet portrait', width: 768, height: 1024 },
  { name: 'phone landscape', width: 844, height: 390 },
  { name: 'phone portrait', width: 390, height: 844 },
]) {
  test(`the Google logo and credits stay visible and uncovered with every UI control, ${viewport.name} (F259)`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(viewport);
    const server = googleFixture(tilePng);
    await page.route('https://tile.googleapis.com/**', (route) => fulfillFrom(route, server.fetch));
    await openSources(page, 'lon=12.5&lat=41.9&zoom=6.5');
    // The application supplies the logo image (the engine ships no Google asset): a fixture image here.
    await mountSource(
      page,
      `(s, key) => s.googleImagery({ id: 'google', apiKey: key, billingRegion: 'eea', mapType: 'roadmap', logoUrl: ${JSON.stringify(LOGO)} })`,
      GOOGLE_FIXTURE_KEY,
    );
    // Every built-in control of the UI package over the same globe.
    await page.evaluate(async (entry) => {
      const ui = (await import(/* @vite-ignore */ entry)) as typeof import('@vibeglobe/ui');
      const globe = window.vibeglobeSources?.globe;
      const container = document.querySelector<HTMLElement>('.vg-source-test');
      if (!globe || !container) throw new Error('no source globe');
      ui.addDefaultControls(ui.createUi(globe, container), { debug: true });
    }, `/@fs${process.cwd()}/packages/ui/src/index.ts`);
    await settledSourceFrame(page, 18);
    await expect.poll(async () => (await creditVisibility(page)).map((c) => c.text)).toContain('Google');
    const check = async (): Promise<void> => {
      const credits = await creditVisibility(page);
      expect(credits.some((credit) => credit.logo)).toBe(true);
      for (const credit of credits) expect(credit, credit.text).toMatchObject({ uncovered: true });
    };
    await check();
    // Page CSS and a script cannot hide or cover them.
    await page.addStyleTag({
      content:
        '.vg-credits { display: none !important; visibility: hidden !important; opacity: 0 !important; } ' +
        '.vg-cover { position: absolute; inset: 0; z-index: 2147483647; background: red; }',
    });
    await page.evaluate(() => {
      const element = document.querySelector<HTMLElement>('.vg-source-test .vg-credits');
      if (element) element.style.display = 'none';
      const cover = document.createElement('div');
      cover.className = 'vg-cover';
      document.querySelector('.vg-source-test')?.append(cover);
    });
    await page.evaluate(() => window.vibeglobeSources?.globe?.requestRender());
    await settledSourceFrame(page, 18);
    await check();
  });
}
