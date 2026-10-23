// The ui package's controls on a live globe (M12, F405, F418–F420, F427, F428): mouse, touch and keyboard.
import { expect, test, type Page } from '@playwright/test';
import { nextFrame, waitForIdle } from './support/globe.ts';
import { cameraOf, openUi, recordCamera, touch, type Sample } from './support/ui-layer.ts';

const control = (page: Page, name: string): ReturnType<Page['locator']> => page.locator(`.vg-ui__button--${name}`);

async function center(page: Page, name: string): Promise<{ x: number; y: number }> {
  const box = await control(page, name).boundingBox();
  if (box === null) throw new Error(`${name} not visible`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** The controls' animation length (TWEEN_DURATION_MS), the smoothstep's peak speed relative to the mean, and the
 * engine clock's largest step per frame (ADR 0009). */
const TWEEN_MS = 300;
const PEAK_SPEED = 1.5;
const MAX_CLOCK_STEP_MS = 100;

/**
 * An animated move: at least two distinct values between start and end, and no jump: no drawn frame moves the camera
 * further than the animation advances in one engine-clock step at its peak speed, whatever the frame rate.
 */
function expectAnimated(samples: readonly Sample[], from: number, to: number, distance = Math.abs(to - from)): void {
  const values = samples.map(({ value }) => value);
  const between = new Set(values.filter((value) => Math.min(from, to) < value && value < Math.max(from, to)));
  expect(between.size).toBeGreaterThanOrEqual(2);
  const maxStep = ((PEAK_SPEED * distance) / TWEEN_MS) * MAX_CLOCK_STEP_MS;
  for (let i = 1; i < values.length; i++)
    expect(Math.abs((values[i] ?? 0) - (values[i - 1] ?? 0))).toBeLessThanOrEqual(maxStep * 1.0001);
  expect(values.at(-1)).toBeCloseTo(to, 9);
}

test.describe('the ui package is optional and its controls are individual (F418)', () => {
  test('the engine runs without the ui package: no ui or gis code is loaded', async ({ page }) => {
    const requested: string[] = [];
    page.on('request', (request) => requested.push(request.url()));
    await page.goto('/');
    await page.waitForFunction(() => window.vibeglobePlayground !== undefined);
    await page.evaluate(async () => window.vibeglobePlayground?.globe.ready);
    expect(requested.filter((url) => /\/packages\/(ui|gis)\/|@vibeglobe\/(ui|gis)|proj4/.test(url))).toEqual([]);
    await expect(page.locator('.vg-ui')).toHaveCount(0);
  });

  test('each control mounts and unmounts cleanly, and one can be replaced by a custom control', async ({ page }) => {
    await openUi(page, { debug: true });
    const ids = ['search', 'zoom', 'compass', 'fullscreen', 'readout', 'debug'];
    for (const id of ids) {
      await expect(page.locator(`[data-control="${id}"]`)).toHaveCount(1);
      const result = await page.evaluate((name) => {
        const handle = window.vibeglobeUi;
        if (handle === undefined) throw new Error('no ui');
        const control = handle.layer.get(name);
        if (control === undefined) throw new Error(`no ${name}`);
        const removed = handle.layer.remove(name);
        const left = document.querySelectorAll(`[data-control="${name}"]`).length;
        handle.layer.add(control);
        return { removed, left };
      }, id);
      expect(result).toEqual({ removed: true, left: 0 });
      await expect(page.locator(`[data-control="${id}"]`)).toHaveCount(1);
    }
    await page.evaluate(() => {
      const handle = window.vibeglobeUi;
      if (handle === undefined) throw new Error('no ui');
      handle.layer.replace({
        id: 'zoom',
        position: 'top-right',
        mount(context) {
          const button = document.createElement('button');
          button.className = 'custom-zoom';
          button.textContent = context.i18n.t('zoom.in');
          button.addEventListener('click', () => context.globe.jumpTo({ zoom: context.globe.camera.zoom + 1 }));
          return button;
        },
        destroy: () => undefined,
      });
    });
    const before = await cameraOf(page);
    await page.locator('.custom-zoom').click();
    await nextFrame(page);
    expect((await cameraOf(page)).zoom).toBeCloseTo(before.zoom + 1, 9);
    await expect(control(page, 'zoom-in')).toHaveCount(0);
    await page.evaluate(() => window.vibeglobeUi?.layer.destroy());
    await expect(page.locator('.vg-ui, .vibeglobe-debug-overlay')).toHaveCount(0);
    expect(await page.evaluate(() => document.adoptedStyleSheets.length)).toBe(0);
  });
});

test.describe('zoom control (F419)', () => {
  test('mouse clicks zoom in animated steps that chain without jumps; the keyboard works too', async ({ page }) => {
    await openUi(page);
    const start = (await cameraOf(page)).zoom;
    const single = await recordCamera(page, 'zoom', () => control(page, 'zoom-in').click());
    expectAnimated(single, start, start + 1);
    // Two presses in quick succession: raw mouse clicks, without Playwright's actionability waits between them.
    const zoomIn = await center(page, 'zoom-in');
    const chained = await recordCamera(page, 'zoom', async () => {
      await page.mouse.click(zoomIn.x, zoomIn.y);
      await page.waitForTimeout(60);
      await page.mouse.click(zoomIn.x, zoomIn.y);
    });
    expectAnimated(chained, start + 1, start + 3, 2);
    for (let i = 1; i < chained.length; i++)
      expect(chained[i]?.value).toBeGreaterThanOrEqual(chained[i - 1]?.value ?? 0);
    await control(page, 'zoom-out').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await expect.poll(async () => (await cameraOf(page)).zoom).toBeCloseTo(start + 1, 9);
  });

  test('buttons are disabled at the minimum and maximum zoom', async ({ page }) => {
    await openUi(page);
    await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ zoom: 22 }));
    await expect(control(page, 'zoom-in')).toBeDisabled();
    await expect(control(page, 'zoom-out')).toBeEnabled();
    // The engine's own minimum, where the whole globe fits the view, is reached by pressing until the step ends short.
    await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ zoom: 1 }));
    await control(page, 'zoom-out').click();
    await expect(control(page, 'zoom-out')).toBeDisabled();
    expect((await cameraOf(page)).zoom).toBeGreaterThan(0);
    await expect(control(page, 'zoom-in')).toBeEnabled();
  });
});

test.describe('compass control (F420)', () => {
  test('the needle shows the heading on every frame', async ({ page }) => {
    await openUi(page);
    for (const heading of [10, 95.5, 200, 359]) {
      await page.evaluate((h) => window.vibeglobePlayground?.globe.jumpTo({ headingDeg: h }), heading);
      await nextFrame(page);
      const transform = await page
        .locator('.vg-ui__compass-needle')
        .evaluate((svg) => (svg as SVGElement).style.transform);
      const shown = Number(/rotate\((-?[\d.]+)deg\)/.exec(transform)?.[1]);
      const camera = await cameraOf(page);
      expect(shown).toBeCloseTo(-camera.headingDeg, 9);
    }
  });

  test('a click resets north with an animation, keeping center and tilt; a mouse drag rotates the map (F190)', async ({
    page,
  }) => {
    await openUi(page);
    await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ headingDeg: 90, tiltDeg: 30 }));
    // After the frames that apply the view's own tilt limits, so that only the compass changes the camera.
    await waitForIdle(page);
    const before = await cameraOf(page);
    const reset = await recordCamera(page, 'headingDeg', () => control(page, 'compass').click());
    expectAnimated(reset, 90, 0);
    const after = await cameraOf(page);
    expect(after.lon).toBeCloseTo(before.lon, 9);
    expect(after.lat).toBeCloseTo(before.lat, 9);
    expect(after.tiltDeg).toBeCloseTo(before.tiltDeg, 9);
    const { x, y } = await center(page, 'compass');
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 30, y, { steps: 5 });
    await page.mouse.move(x - 60, y, { steps: 5 });
    await page.mouse.up();
    await nextFrame(page);
    // 0.5° per pixel: dragging 60 px left turns the heading 30° clockwise; the press does not reset north.
    expect((await cameraOf(page)).headingDeg).toBeCloseTo(30, 6);
  });

  test('keyboard alone resets north, rotates and orients to N, E, S and W', async ({ page }) => {
    await openUi(page);
    await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ headingDeg: 40 }));
    await control(page, 'compass').focus();
    const heading = async (): Promise<number> => (await cameraOf(page)).headingDeg;
    await page.keyboard.press('Enter');
    await expect.poll(heading).toBeCloseTo(0, 9);
    await page.keyboard.press('ArrowRight');
    await expect.poll(heading).toBeCloseTo(15, 9);
    for (const [key, expected] of [
      ['e', 90],
      ['s', 180],
      ['w', 270],
      ['n', 0],
    ] as const) {
      await page.keyboard.press(key);
      await expect.poll(async () => ((await heading()) + 360) % 360).toBeCloseTo(expected, 9);
    }
  });
});

test.describe('fullscreen control (F427)', () => {
  test('enters and leaves fullscreen with the mouse and the keyboard, resizing the canvas', async ({ page }) => {
    await openUi(page);
    const button = control(page, 'fullscreen');
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await button.click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('app');
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    // The canvas follows the container: its drawing buffer matches the new size, so nothing is stretched.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const canvas = document.querySelector<HTMLCanvasElement>('#globe');
          const app = document.getElementById('app');
          if (canvas === null || app === null) return false;
          return (
            canvas.width === Math.round(app.clientWidth * devicePixelRatio) &&
            canvas.height === Math.round(app.clientHeight * devicePixelRatio)
          );
        }),
      )
      .toBe(true);
    const frame = await page.evaluate(() => window.vibeglobePlayground?.globe.frameNumber ?? 0);
    await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ headingDeg: 5 }));
    await expect
      .poll(() => page.evaluate(() => window.vibeglobePlayground?.globe.frameNumber ?? 0))
      .toBeGreaterThan(frame);
    await button.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
    await expect(button).toHaveAttribute('aria-pressed', 'false');
  });

  test('is hidden where the Fullscreen API is unavailable', async ({ page }) => {
    await page.addInitScript(() =>
      Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false }),
    );
    await openUi(page);
    await expect(page.locator('[data-control="fullscreen"]')).toBeHidden();
  });
});

test.describe('debug panel toggle (F428)', () => {
  test('is absent unless enabled', async ({ page }) => {
    await openUi(page);
    await expect(page.locator('[data-control="debug"]')).toHaveCount(0);
  });

  test('shows and hides the debug overlay and performance HUD with the mouse and the keyboard', async ({ page }) => {
    await openUi(page, { debug: true });
    const toggle = control(page, 'debug');
    const overlay = page.locator('.vg-ui .vibeglobe-debug-overlay');
    await toggle.click();
    for (let heading = 1; heading <= 10; heading++) {
      await page.evaluate((h) => window.vibeglobePlayground?.globe.jumpTo({ headingDeg: h }), heading);
      await nextFrame(page);
    }
    await expect(overlay.locator('[data-metric="frame-time"]')).toHaveText(/frame \d+\.\d ms/);
    await expect(overlay.locator('[data-metric="backend"]')).toHaveText(/backend webgl2|backend webgpu/);
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await toggle.click();
    await expect(overlay).toHaveCount(0);
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(overlay).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(overlay).toHaveCount(0);
  });
});

test.describe('the readout and the search box use the gis coordinate functions (F405)', () => {
  test('the readout shows formatCoordinate of the point under the pointer in each format', async ({ page }) => {
    await openUi(page);
    const box = await page.locator('#globe').boundingBox();
    if (box === null) throw new Error('no canvas');
    const point = { xPx: box.width / 2 + 40, yPx: box.height / 2 - 30 };
    await page.mouse.move(box.x + point.xPx, box.y + point.yPx);
    for (const format of ['decimal', 'dms', 'utm'] as const) {
      const expected = await page.evaluate(
        ({ p, f }) => {
          const position = window.vibeglobePlayground?.globe.screenToGeo(p);
          return position === undefined ? undefined : window.vibeglobeUi?.gis.formatCoordinate(position, f);
        },
        { p: point, f: format },
      );
      expect(expected).toBeDefined();
      await expect(page.locator('.vg-ui__readout-coordinates')).toHaveText(expected ?? '');
      await control(page, 'readout-format').click();
      await page.mouse.move(box.x + point.xPx, box.y + point.yPx);
    }
  });

  test('typed decimal, DMS and UTM coordinates in the search box go to that place', async ({ page }) => {
    // The search box flies there (F204); with reduced motion the flight is a short fade (F214), so each check starts
    // after arrival rather than after a flight of many seconds on the software GPU.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openUi(page);
    const input = page.locator('.vg-ui__search-input');
    for (const [text, lon, lat] of [
      ['41.9028, 12.4964', 12.4964, 41.9028],
      ['33°52′07.68″S 151°12′33.48″E', 151.2093, -33.8688],
      ['32T 514853 5034538', 9.19, 45.4642],
    ] as const) {
      await input.fill(text);
      await expect(page.locator('.vg-ui__search-option').first()).toContainText('Go to');
      await input.press('Enter');
      await expect.poll(async () => (await cameraOf(page)).lon).toBeCloseTo(lon, 4);
      expect((await cameraOf(page)).lat).toBeCloseTo(lat, 4);
    }
  });
});

test.describe('touch', () => {
  test.use({ hasTouch: true });

  test('taps zoom, reset north, toggle fullscreen and the debug panel; a touch drag rotates the compass', async ({
    page,
  }) => {
    await openUi(page, { debug: true });
    const start = (await cameraOf(page)).zoom;
    const zoomIn = await center(page, 'zoom-in');
    const zooms = await recordCamera(page, 'zoom', () => touch(page, zoomIn.x, zoomIn.y));
    expectAnimated(zooms, start, start + 1);

    await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ headingDeg: 60 }));
    const compass = await center(page, 'compass');
    await touch(page, compass.x, compass.y);
    await expect.poll(async () => (await cameraOf(page)).headingDeg).toBeCloseTo(0, 9);
    await touch(page, compass.x, compass.y, -40);
    await expect.poll(async () => (await cameraOf(page)).headingDeg).toBeCloseTo(20, 6);

    const debug = await center(page, 'debug');
    await touch(page, debug.x, debug.y);
    await expect(page.locator('.vg-ui .vibeglobe-debug-overlay')).toHaveCount(1);

    const fullscreen = await center(page, 'fullscreen');
    await touch(page, fullscreen.x, fullscreen.y);
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id)).toBe('app');
    const exit = await center(page, 'fullscreen');
    await touch(page, exit.x, exit.y);
    await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
  });
});
