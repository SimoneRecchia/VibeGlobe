// M12 acceptance (F438): every ready-made control and GIS tool driven by one input alone: the mouse, emulated touch or
// the keyboard, in English and Italian, light and dark themes. Text is typed where a control asks for text (a search, a
// bookmark name); everything else is pressed, tapped or clicked. The per-control specs (`e2e/ui-*.spec.ts`) check each
// behavior in depth; this suite checks that no control needs a second input.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { waitForIdle } from './support/globe.ts';
import { fixtureSession, waitForImagery } from './support/imagery.ts';
import { cameraOf, loadLayers, openUi, touch } from './support/ui-layer.ts';

test.use({ viewport: { width: 1280, height: 800 }, hasTouch: true });

type Input = 'mouse' | 'touch' | 'keyboard';

/** Turns a button, checkbox or option on with the input alone. */
async function activate(page: Page, input: Input, target: Locator): Promise<void> {
  if (input === 'mouse') await target.click();
  else if (input === 'touch') {
    const box = await target.boundingBox();
    if (box === null) throw new Error('not visible');
    await touch(page, box.x + box.width / 2, box.y + box.height / 2);
  } else {
    await target.focus();
    await target.press((await target.getAttribute('type')) === 'checkbox' ? 'Space' : 'Enter');
  }
}

/** Places a point of a drawing tool at a screen point (keyboard: moves the tool's cursor there first). */
async function place(page: Page, input: Input, xPx: number, yPx: number, finish = false): Promise<void> {
  if (input === 'mouse') {
    if (finish) await page.mouse.dblclick(xPx, yPx);
    else await page.mouse.click(xPx, yPx);
  } else if (input === 'touch') {
    await touch(page, xPx, yPx);
    if (finish) await touch(page, xPx, yPx);
  } else {
    await moveCursor(page, xPx, yPx);
    await page.keyboard.press('Enter');
    if (finish) await page.keyboard.press('Enter');
  }
}

/** Moves the focused drawing cursor to a screen point, 40 px a step with Shift, then 8 px. */
async function moveCursor(page: Page, xPx: number, yPx: number): Promise<void> {
  const [x, y] = await page
    .locator(':focus')
    .evaluate((element: HTMLElement) => [Number.parseFloat(element.style.left), Number.parseFloat(element.style.top)]);
  for (const [delta, positive, negative] of [
    [xPx - (x ?? 0), 'ArrowRight', 'ArrowLeft'],
    [yPx - (y ?? 0), 'ArrowDown', 'ArrowUp'],
  ] as const) {
    const key = delta > 0 ? positive : negative;
    for (let i = 0; i < Math.floor(Math.abs(delta) / 40); i++) await page.keyboard.press(`Shift+${key}`);
    for (let i = 0; i < Math.round((Math.abs(delta) % 40) / 8); i++) await page.keyboard.press(key);
  }
}

/** Drags from a screen point by `dxPx` with the mouse or a finger (keyboard: picks at the cursor, then moves left). */
async function drag(page: Page, input: Input, xPx: number, yPx: number, dxPx: number): Promise<void> {
  if (input === 'mouse') {
    await page.mouse.move(xPx, yPx);
    await page.mouse.down();
    await page.mouse.move(xPx + dxPx, yPx, { steps: 5 });
    await page.mouse.up();
  } else if (input === 'touch') await touch(page, xPx, yPx, dxPx);
  else {
    await moveCursor(page, xPx, yPx);
    await page.keyboard.press('Enter');
    for (let i = 0; i < Math.round(Math.abs(dxPx) / 8); i++)
      await page.keyboard.press(dxPx > 0 ? 'ArrowRight' : 'ArrowLeft');
    await page.keyboard.press('Enter');
  }
}

/** Waits for the next movement started by a control (the API) to end. */
async function movementEnd(page: Page, action: () => Promise<void>): Promise<void> {
  // Not the end of an earlier control's flight.
  await waitForIdle(page);
  await page.evaluate(() => {
    const globe = window.vibeglobePlayground?.globe;
    const holder = window as unknown as { ended?: boolean };
    holder.ended = false;
    const stop = globe?.on('moveend', ({ cause }) => {
      if (cause !== 'api') return;
      holder.ended = true;
      stop?.();
    });
  });
  await action();
  await page.waitForFunction(() => (window as unknown as { ended?: boolean }).ended === true);
}

/** Opens every control: the full set, the debug toggle, bookmarks, screenshot, minimap, measurement and drawing. */
async function openEverything(page: Page, language: string, theme: 'light' | 'dark'): Promise<void> {
  const session = await fixtureSession(page);
  await openUi(page, {
    defaults: 'all',
    debug: true,
    theme,
    language,
    query: `backend=webgl2&imagery=smooth&overlays=stripes:0.5&session=${session}&lon=7.6&lat=45.9&zoom=6`,
  });
  await loadLayers(page);
  await page.evaluate(() => {
    const handle = window.vibeglobeUi;
    const globe = window.vibeglobePlayground?.globe;
    if (handle?.layers === undefined || globe === undefined) throw new Error('no ui');
    handle.layer.replace(
      new handle.ui.LayerSwitcherControl({
        overlays: ['overlay-stripes'],
        names: { 'fixture-smooth': 'Smooth', 'overlay-stripes': 'Stripes' },
        dataLayers: handle.layers.createGlobeLayers(globe),
      }),
    );
    handle.layer.add(new handle.ui.BookmarksControl());
    handle.layer.add(new handle.ui.ScreenshotControl());
    handle.layer.add(new handle.minimap.MinimapControl({ imageUrl: '/imagery/natural-earth-4096.jpg' }));
    handle.layer.add(new handle.ui.MeasureControl());
    handle.layer.add(new handle.ui.DrawControl());
  });
  await waitForImagery(page);
  await page.waitForFunction(() => window.vibeglobePlayground?.globe.layerTarget() !== undefined);
}

const button = (page: Page, name: string, control?: string): Locator =>
  page.locator(`${control === undefined ? '' : `[data-control="${control}"] `}.vg-ui__button--${name}`);

/** Strings the checks read, in each language (`packages/ui/src/i18n`). */
const TEXT = {
  en: { length: 'Length', goTo: 'Go to' },
  it: { length: 'Lunghezza', goTo: 'Vai a' },
} as const;

for (const input of ['mouse', 'touch', 'keyboard'] as const)
  for (const [language, theme] of [
    ['en', 'light'],
    ['it', 'dark'],
  ] as const)
    test(`every control and GIS tool works with the ${input} alone, ${language}, ${theme} theme (F438)`, async ({
      page,
      context,
    }) => {
      test.setTimeout(180_000);
      await context.grantPermissions(['geolocation']);
      await context.setGeolocation({ latitude: 45.07, longitude: 7.69, accuracy: 300 });
      // The Italian runs with reduced motion (quick fades), the English ones with every animation.
      if (language === 'it') await page.emulateMedia({ reducedMotion: 'reduce' });
      await openEverything(page, language, theme);
      expect(await page.locator('.vg-ui').getAttribute('lang')).toBe(language);
      expect(await page.locator('.vg-ui').getAttribute('data-theme')).toBe(theme);
      const zoom = async (): Promise<number> => (await cameraOf(page)).zoom;

      await test.step('zoom', async () => {
        const start = await zoom();
        await activate(page, input, button(page, 'zoom-in'));
        await expect.poll(zoom).toBeCloseTo(start + 1, 6);
        await activate(page, input, button(page, 'zoom-out'));
        await expect.poll(zoom).toBeCloseTo(start, 6);
      });

      await test.step('compass', async () => {
        await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ headingDeg: 60 }));
        await waitForIdle(page);
        await activate(page, input, button(page, 'compass'));
        // Degrees from north either way.
        const heading = async (): Promise<number> => {
          const h = (((await cameraOf(page)).headingDeg % 360) + 360) % 360;
          return Math.min(h, 360 - h);
        };
        await expect.poll(heading).toBeCloseTo(0, 6);
        // Rotating: a drag of the compass, or a key to face east.
        const box = await button(page, 'compass').boundingBox();
        if (box === null) throw new Error('no compass');
        if (input === 'keyboard') await button(page, 'compass').press('e');
        else if (input === 'touch') await touch(page, box.x + box.width / 2, box.y + box.height / 2, -40);
        else {
          await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await page.mouse.down();
          await page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2, { steps: 5 });
          await page.mouse.up();
        }
        await expect.poll(heading).toBeGreaterThan(5);
        await activate(page, input, button(page, 'compass'));
        await expect.poll(heading).toBeCloseTo(0, 6);
      });

      await test.step('view mode and tilt', async () => {
        const mode = (): Promise<string | undefined> => page.evaluate(() => window.vibeglobePlayground?.globe.viewMode);
        await activate(page, input, button(page, 'view-3d'));
        await expect.poll(mode).toBe('manual');
        const chosen = (): Promise<number> =>
          page.evaluate(() => window.vibeglobePlayground?.globe.camera.chosenTiltDeg ?? NaN);
        const before = await chosen();
        const slider = page.locator('.vg-ui__tilt-track');
        const box = await slider.boundingBox();
        if (box === null) throw new Error('no tilt slider');
        if (input === 'keyboard') await slider.press('ArrowDown');
        else if (input === 'touch') await touch(page, box.x + box.width / 2, box.y + box.height * 0.85);
        else await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.85);
        await expect.poll(chosen).toBeLessThan(before);
        await activate(page, input, button(page, 'view-2d'));
        await expect.poll(mode).toBe('2d');
        await activate(page, input, button(page, 'view-auto'));
        await expect.poll(mode).toBe('auto');
      });

      await test.step('reset to the globe and home', async () => {
        await waitForIdle(page);
        await movementEnd(page, () => activate(page, input, button(page, 'reset-globe')));
        expect(await zoom()).toBeLessThan(4);
        await movementEnd(page, () => activate(page, input, button(page, 'home')));
        expect(await zoom()).toBeCloseTo(6, 3);
      });

      await test.step('geolocation', async () => {
        await activate(page, input, button(page, 'geolocate'));
        await expect(button(page, 'geolocate')).toHaveAttribute('aria-pressed', 'true');
        await expect.poll(async () => (await cameraOf(page)).lon, { timeout: 20_000 }).toBeCloseTo(7.69, 2);
        await activate(page, input, button(page, 'geolocate'));
        await expect(button(page, 'geolocate')).toHaveAttribute('aria-pressed', 'false');
      });

      await test.step('layer switcher', async () => {
        const visible = (): Promise<boolean | undefined> =>
          page.evaluate(
            () =>
              window.vibeglobePlayground?.globe.imageryLayers.list().find((l) => l.id === 'overlay-stripes')?.visible,
          );
        await activate(page, input, button(page, 'layers'));
        await expect(button(page, 'layers')).toHaveAttribute('aria-expanded', 'true');
        await activate(page, input, page.locator('.vg-ui__layers-panel').getByRole('checkbox', { name: 'Stripes' }));
        await expect.poll(visible).toBe(false);
        await activate(page, input, button(page, 'layers'));
        await expect(button(page, 'layers')).toHaveAttribute('aria-expanded', 'false');
      });

      await test.step('coordinate readout and scale bar', async () => {
        const format = (): Promise<string> =>
          page.evaluate(() => (window.vibeglobeUi?.layer.get('readout') as unknown as { format: string }).format);
        const first = await format();
        await activate(page, input, button(page, 'readout-format'));
        await expect.poll(format).not.toBe(first);
        const coordinates = page.locator('.vg-ui__readout-coordinates');
        await expect(coordinates).not.toHaveText('');
        const shown = await coordinates.textContent();
        // The position under the pointer or a held finger (the keyboard's part is the format switch above).
        if (input === 'mouse') await page.mouse.move(400, 300);
        else if (input === 'touch') await touch(page, 400, 300, 0, 600);
        if (input !== 'keyboard') await expect(coordinates).not.toHaveText(shown ?? '');
        await expect(page.locator('.vg-ui__scale')).toHaveAttribute('aria-label', /\d/);
      });

      await test.step('search', async () => {
        const input_ = page.locator('.vg-ui__search-input');
        await input_.fill('45.4642, 9.19');
        const option = page.locator('.vg-ui__search-option').first();
        await expect(option).toContainText(TEXT[language].goTo);
        await movementEnd(page, () => (input === 'keyboard' ? input_.press('Enter') : activate(page, input, option)));
        expect((await cameraOf(page)).lon).toBeCloseTo(9.19, 3);
      });

      await test.step('debug panel', async () => {
        const overlay = page.locator('.vg-ui .vibeglobe-debug-overlay');
        await activate(page, input, button(page, 'debug'));
        await expect(overlay).toHaveCount(1);
        await activate(page, input, button(page, 'debug'));
        await expect(overlay).toHaveCount(0);
      });

      await test.step('bookmarks', async () => {
        const count = (): Promise<number> =>
          page.evaluate(
            () => (window.vibeglobeUi?.layer.get('bookmarks') as unknown as { list(): unknown[] }).list().length,
          );
        await activate(page, input, button(page, 'bookmarks'));
        await page.locator('.vg-ui__bookmarks-panel .vg-ui__text-input').fill('Milano');
        await activate(page, input, button(page, 'bookmark-add'));
        await expect.poll(count).toBe(1);
        await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: 2.35, latitudeDeg: 48.85 }));
        await waitForIdle(page);
        await movementEnd(page, () => activate(page, input, button(page, 'bookmark-go').first()));
        expect((await cameraOf(page)).lon).toBeCloseTo(9.19, 3);
        await activate(page, input, button(page, 'bookmarks'));
      });

      await test.step('screenshot', async () => {
        const download = page.waitForEvent('download');
        await activate(page, input, button(page, 'screenshot'));
        expect((await download).suggestedFilename()).toBe('vibeglobe.png');
      });

      await test.step('minimap', async () => {
        await expect(page.locator('.vg-ui__minimap-canvas')).toBeVisible();
      });

      await test.step('measurement', async () => {
        const readout = page.locator('.vg-ui__measure-readout');
        await activate(page, input, button(page, 'draw-line', 'measure'));
        await place(page, input, 560, 400);
        await place(page, input, 640, 400, true);
        await expect(readout).toContainText(TEXT[language].length);
        await activate(page, input, button(page, 'draw-polygon', 'measure'));
        await place(page, input, 560, 440);
        await place(page, input, 640, 440);
        await place(page, input, 600, 500);
        await activate(page, input, button(page, 'draw-finish', 'measure'));
        await expect(readout).toContainText('²');
        await activate(page, input, button(page, 'draw-polygon', 'measure'));
      });

      await test.step('drawing', async () => {
        const points = (): Promise<number> =>
          page.evaluate(
            () =>
              (window.vibeglobeUi?.layer.get('draw') as unknown as { tool: { features(): unknown[] } }).tool.features()
                .length,
          );
        const types = (): Promise<string[]> =>
          page.evaluate(() =>
            (
              window.vibeglobeUi?.layer.get('draw') as unknown as {
                tool: { features(): { geometry: { type: string } }[] };
              }
            ).tool
              .features()
              .map((f) => f.geometry.type),
          );
        await activate(page, input, button(page, 'draw-point', 'draw'));
        await place(page, input, 700, 420);
        await expect.poll(points).toBe(1);
        await activate(page, input, button(page, 'draw-line', 'draw'));
        await place(page, input, 680, 360);
        await place(page, input, 760, 360, true);
        await activate(page, input, button(page, 'draw-polygon', 'draw'));
        await place(page, input, 680, 460);
        await place(page, input, 760, 460);
        await place(page, input, 720, 520);
        await activate(page, input, button(page, 'draw-finish', 'draw'));
        await expect.poll(types).toEqual(['Point', 'LineString', 'Polygon']);
        // Editing: select the polygon by an edge, then drag its first vertex.
        const vertex = async (): Promise<number[]> =>
          page.evaluate(
            () =>
              (
                window.vibeglobeUi?.layer.get('draw') as unknown as {
                  tool: { features(): { geometry: { coordinates: number[][][] } }[] };
                }
              ).tool.features()[2]?.geometry.coordinates[0]?.[0] ?? [],
          );
        const before = await vertex();
        const screen = await page.evaluate(
          ([lon, lat]) =>
            window.vibeglobePlayground?.globe.geoToScreen({ longitudeDeg: lon ?? 0, latitudeDeg: lat ?? 0 }),
          before,
        );
        if (screen === undefined) throw new Error('vertex off screen');
        await activate(page, input, button(page, 'draw-edit', 'draw'));
        await place(page, input, screen.xPx + 20, screen.yPx);
        await drag(page, input, screen.xPx, screen.yPx, -32);
        await expect.poll(async () => (await vertex())[0]).toBeLessThan(before[0] ?? 0);
        await activate(page, input, button(page, 'draw-edit', 'draw'));
      });

      await test.step('fullscreen', async () => {
        const element = (): Promise<string | undefined> => page.evaluate(() => document.fullscreenElement?.id);
        await activate(page, input, button(page, 'fullscreen'));
        await expect.poll(element).toBe('app');
        await activate(page, input, button(page, 'fullscreen'));
        await expect.poll(element).toBeUndefined();
      });

      await test.step('attribution on a narrow map', async () => {
        await page.setViewportSize({ width: 400, height: 640 });
        const toggle = button(page, 'attribution');
        await expect(toggle).toBeVisible();
        const expanded = await toggle.getAttribute('aria-expanded');
        await activate(page, input, toggle);
        await expect(toggle).not.toHaveAttribute('aria-expanded', expanded ?? '');
      });
    });
