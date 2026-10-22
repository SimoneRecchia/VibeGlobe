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

  await expect(page).toHaveTitle('VibeGlobe playground');
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#app canvas#globe')).toBeVisible();
  await expect(page.locator('#status')).toContainText('WGS84, a = 6378137 m');
  expect(errors).toEqual([]);
});

test('debug overlay shows live frame time and frame rate with ?debug=1', async ({ page }) => {
  const errors = collectErrors(page);

  await page.goto('/?debug=1');

  const frameTime = page.locator('.vibeglobe-debug-overlay [data-metric="frame-time"]');
  const frameRate = page.locator('.vibeglobe-debug-overlay [data-metric="frame-rate"]');
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

  await expect(page.locator('.vibeglobe-debug-overlay')).toHaveCount(0);
  expect(requested.filter((url) => url.includes('debug-overlay') || url.includes('/packages/ui/'))).toEqual([]);
});

test('the frame loop keeps bounded CPU samples and piles up no performance entries (KB-006)', async ({ page }) => {
  await page.goto('/?scenario=frame-loop');

  const samples = (): Promise<number> =>
    page.evaluate(
      () =>
        (window as { vibeglobePlayground?: { cpuFrameTimesMs(): number[] } }).vibeglobePlayground?.cpuFrameTimesMs()
          .length ?? 0,
    );
  await expect.poll(samples, { timeout: 5000 }).toBeGreaterThan(30);
  expect(await page.evaluate(() => performance.getEntriesByType('measure').length)).toBe(0);
});

test.describe('in a small window, so the software GPU draws many frames', () => {
  test.use({ viewport: { width: 320, height: 240 } });

  test('continuous motion does not grow the recorded event log (KB-010)', async ({ page }) => {
    await page.goto('/?lon=10&lat=45&zoom=3');
    await page.waitForFunction(() => window.vibeglobePlayground !== undefined);
    await page.evaluate(async () => window.vibeglobePlayground?.globe.ready);
    const counts = await page.evaluate(async () => {
      const hooks = window.vibeglobePlayground;
      if (!hooks) throw new Error('no hooks');
      const { globe } = hooks;
      const anchor = globe.navigation.grab({ xPx: 160, yPx: 120 });
      if (!anchor) throw new Error('no anchor');
      const before = hooks.events.length;
      const framesBefore = globe.frameNumber;
      // Drag from animation frames, as a pointer would, until 30 frames are drawn (at most 20 s on a loaded machine).
      await new Promise<void>((done) => {
        const start = performance.now();
        const tick = (time: number): void => {
          const angle = (time - start) / 200;
          globe.navigation.dragTo(anchor, { xPx: 160 + 30 * Math.cos(angle), yPx: 120 + 30 * Math.sin(angle) });
          if (globe.frameNumber - framesBefore < 30 && time - start < 20_000) requestAnimationFrame(tick);
          else done();
        };
        requestAnimationFrame(tick);
      });
      return { added: hooks.events.length - before, frames: globe.frameNumber - framesBefore };
    });
    expect(counts.frames).toBeGreaterThanOrEqual(30);
    expect(counts.added).toBe(0);
  });
});
