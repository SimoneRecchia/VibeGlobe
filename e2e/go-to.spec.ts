// Go to coordinates and the pluggable geocoder (M6, F204–F208) through the ui package's search box on the playground.
import { readdirSync, readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { openUi } from './support/ui-layer.ts';

test.use({ viewport: { width: 640, height: 480 } });

const CLOCK = 'clockStepMs=16.666666666666668';
const START = 'lon=9.5&lat=45.2&zoom=10';

/** The search box with an optional mock geocoder (one place with bounds) instead of the default controls. */
async function openSearch(page: Page, geocoder: boolean): Promise<void> {
  await openUi(page, { query: `${CLOCK}&backend=webgl2&${START}`, defaults: false });
  await page.evaluate((withGeocoder) => {
    const handle = window.vibeglobeUi;
    if (!handle) throw new Error('no ui');
    const queries: string[] = [];
    (window as unknown as { geocoderQueries: string[] }).geocoderQueries = queries;
    const mock = {
      search: (query: string) => {
        queries.push(query);
        return Promise.resolve(
          query.toLowerCase().startsWith('como')
            ? [
                {
                  label: 'Lake Como',
                  longitudeDeg: 9.26,
                  latitudeDeg: 46.0,
                  bounds: { westDeg: 9.05, southDeg: 45.78, eastDeg: 9.45, northDeg: 46.2 },
                },
              ]
            : [],
        );
      },
    };
    handle.layer.add(new handle.ui.SearchControl(withGeocoder ? { geocoder: mock, debounceMs: 0 } : {}));
  }, geocoder);
}

/** Types into the search box, chooses the first option with Enter and waits for the movement to end. */
async function goTo(page: Page, text: string): Promise<{ longitudeDeg: number; latitudeDeg: number }> {
  const ended = page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const off = window.vibeglobePlayground?.globe.on('moveend', ({ outcome }) => {
          off?.();
          resolve(outcome);
        });
      }),
  );
  const input = page.locator('.vg-ui__search-input');
  await input.fill(text);
  await expect(page.locator('.vg-ui__search-option').first()).toBeVisible();
  await input.press('Enter');
  expect(await ended).toBe('completed');
  return page.evaluate(() => {
    const camera = window.vibeglobePlayground?.globe.camera;
    if (!camera) throw new Error('no globe');
    return { longitudeDeg: camera.longitudeDeg, latitudeDeg: camera.latitudeDeg };
  });
}

test('typed decimal degrees, degrees-minutes-seconds and UTM fly the camera there (F204, F205, F206)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await openSearch(page, false);
  for (const [text, lon, lat] of [
    ['45.4642, 9.19', 9.19, 45.4642],
    ['N45.4642 E9.19', 9.19, 45.4642],
    [`45°27'51.1"N 9°11'24.0"E`, 9 + 11 / 60 + 24 / 3600, 45 + 27 / 60 + 51.1 / 3600],
    ['45° 27.852′ N, 9° 11.4′ E', 9 + 11.4 / 60, 45 + 27.852 / 60],
    ['32T 514853.4959 5034536.7962', 9.19, 45.4642],
  ] as const) {
    const camera = await goTo(page, text);
    expect(camera.longitudeDeg, text).toBeCloseTo(lon, 6);
    expect(camera.latitudeDeg, text).toBeCloseTo(lat, 6);
  }
});

test('an invalid coordinate shows its error and does not move the camera (F207)', async ({ page }) => {
  await openSearch(page, false);
  const before = await page.evaluate(() => window.vibeglobePlayground?.globe.camera.longitudeDeg);
  const input = page.locator('.vg-ui__search-input');
  for (const [text, message] of [
    ['95, 9', /latitude/i],
    ['45, 190', /longitude/i],
    ['61T 500000 5000000', /UTM/],
    ['45°61′ N 9° E', /60/],
  ] as const) {
    await input.fill(text);
    await expect(page.locator('.vg-ui__search-status')).toHaveText(message);
    await input.press('Enter');
    await expect(page.locator('.vg-ui__search-option')).toHaveCount(0);
  }
  expect(await page.evaluate(() => window.vibeglobePlayground?.globe.camera.longitudeDeg)).toBe(before);
});

test('a registered geocoder lists places with positions and bounds and choosing one flies there; without one no request is made (F208)', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openSearch(page, true);
  const camera = await goTo(page, 'Como');
  // The place's bounds fill the view: the camera looks at their center.
  expect(camera.longitudeDeg).toBeCloseTo(9.25, 1);
  expect(camera.latitudeDeg).toBeCloseTo(45.99, 1);
  expect(await page.evaluate(() => (window as unknown as { geocoderQueries: string[] }).geocoderQueries)).toContain(
    'Como',
  );
  // Without a geocoder: the box says only coordinates work, and typing sends nothing anywhere.
  await page.goto('about:blank');
  await openSearch(page, false);
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.locator('.vg-ui__search-input').fill('Milan');
  await expect(page.locator('.vg-ui__search-status')).toHaveText(/coordinates/i);
  await page.waitForTimeout(500);
  expect(requests.filter((url) => /milan/i.test(url))).toEqual([]);
});

test('no package depends on a geocoding provider (F208)', () => {
  // Geocoding clients by name (a vector-tile decoder such as @mapbox/vector-tile is not one).
  const PROVIDERS =
    /geocod|nominatim|pelias|opencage|mapbox-sdk|mapbox-gl-geocoder|google-maps-services|@arcgis\/|here-js/i;
  for (const dir of ['packages', 'apps']) {
    for (const name of readdirSync(dir)) {
      let manifest: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      try {
        manifest = JSON.parse(readFileSync(`${dir}/${name}/package.json`, 'utf8')) as typeof manifest;
      } catch {
        continue;
      }
      const deps = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
      expect(
        deps.filter((dep) => PROVIDERS.test(dep)),
        `${dir}/${name}`,
      ).toEqual([]);
    }
  }
});
