import { expect, test, type Page } from '@playwright/test';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

test('playground loads without errors', async ({ page }) => {
  const errors = collectErrors(page);

  await page.goto('/');

  await expect(page).toHaveTitle('VibeGlobeEngine playground');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#app canvas#globe')).toBeVisible();
  await expect(page.locator('#status')).toContainText('WGS84, a = 6378137 m');
  expect(errors).toEqual([]);
});

test('debug overlay shows live frame time and frame rate with ?debug=1', async ({ page }) => {
  const errors = collectErrors(page);

  await page.goto('/?debug=1');

  const frameTime = page.locator('.vge-debug-overlay [data-metric="frame-time"]');
  const frameRate = page.locator('.vge-debug-overlay [data-metric="frame-rate"]');
  await expect(frameTime).toHaveText(/frame \d+\.\d ms/);
  await expect(frameRate).toHaveText(/rate {2}\d+\.\d fps/);
  // A long frame must show up in the live values: block the main thread once and wait for the overlay to change.
  const first = await frameTime.textContent();
  await page.evaluate(() => {
    const end = performance.now() + 300;
    while (performance.now() < end);
  });
  await expect.poll(() => frameTime.textContent(), { timeout: 5000 }).not.toBe(first);
  expect(errors).toEqual([]);
});

test('debug overlay is absent and its code not loaded without ?debug=1', async ({ page }) => {
  const requested: string[] = [];
  page.on('request', (request) => requested.push(request.url()));

  await page.goto('/');
  await expect(page.locator('#status')).toContainText('WGS84');

  await expect(page.locator('.vge-debug-overlay')).toHaveCount(0);
  expect(requested.filter((url) => url.includes('debug-overlay') || url.includes('/packages/ui/'))).toEqual([]);
});
