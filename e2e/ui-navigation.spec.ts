// The ui package's navigation controls on a live globe (M12, F412, F413, F421–F425): mouse, touch and keyboard.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { nextFrame, waitForIdle } from './support/globe.ts';
import { fixtureSession, waitForImagery } from './support/imagery.ts';
import { loadLayers, openUi, touch } from './support/ui-layer.ts';

test.use({ viewport: { width: 640, height: 480 }, hasTouch: true });

/** Taps the center of an element with a real touch sequence. */
async function tap(page: Page, locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('not visible');
  await touch(page, box.x + box.width / 2, box.y + box.height / 2);
}

/** Focuses an element and presses a key. */
async function press(locator: Locator, key: string): Promise<void> {
  await locator.focus();
  await locator.press(key);
}

/** The engine's view mode and applied and chosen tilt. */
async function tiltState(page: Page): Promise<{ mode: string; tilt: number; chosen: number }> {
  return page.evaluate(() => {
    const globe = window.vibeglobePlayground?.globe;
    if (globe === undefined) throw new Error('no globe');
    return { mode: globe.viewMode, tilt: globe.camera.tiltDeg, chosen: globe.camera.chosenTiltDeg };
  });
}

/** Records the applied tilt on every drawn frame until the engine goes idle. */
async function recordTilt(page: Page, action: () => Promise<void>): Promise<number[]> {
  await page.evaluate(() => {
    const globe = window.vibeglobePlayground?.globe;
    if (globe === undefined) throw new Error('no globe');
    const samples: number[] = [];
    const stop = globe.on('frame', () => samples.push(globe.camera.tiltDeg));
    (window as unknown as { tiltRecord: { samples: number[]; stop: () => void } }).tiltRecord = { samples, stop };
  });
  await action();
  await waitForIdle(page);
  return page.evaluate(() => {
    const record = (window as unknown as { tiltRecord: { samples: number[]; stop: () => void } }).tiltRecord;
    record.stop();
    return record.samples;
  });
}

/** A smooth transition: several distinct intermediate values, ending at `to`. */
function expectSmooth(samples: readonly number[], to: number): void {
  const last = samples.at(-1) ?? NaN;
  expect(last).toBeCloseTo(to, 1);
  const first = samples[0] ?? last;
  const between = new Set(samples.filter((v) => Math.min(first, to) + 0.01 < v && v < Math.max(first, to) - 0.01));
  expect(between.size).toBeGreaterThanOrEqual(2);
}

test.describe('the 2D / 3D / Auto toggle (F421)', () => {
  test('sets 2D, 3D and Auto with mouse, touch and keyboard, smoothly, and shows the mode', async ({ page }) => {
    await openUi(page, { query: 'backend=webgl2&lon=7.6&lat=45.9&zoom=12' });
    await waitForIdle(page);
    const button = (mode: string): Locator => page.locator(`.vg-ui__button--view-${mode}`);
    const back = page.locator('.vg-ui__button--back-to-auto');
    await expect(button('auto')).toHaveAttribute('aria-pressed', 'true');
    await expect(back).toBeHidden();
    const autoTilt = (await tiltState(page)).tilt;

    // Mouse: 3D chooses the default tilt (manual mode), smoothly.
    const to3d = await recordTilt(page, () => button('3d').click());
    const state3d = await tiltState(page);
    expect(state3d.mode).toBe('manual');
    expect(state3d.tilt).toBeGreaterThan(autoTilt + 5);
    expectSmooth(to3d, state3d.tilt);
    await expect(button('3d')).toHaveAttribute('aria-pressed', 'true');
    await expect(back).toBeVisible();

    // Touch: 2D sets the tilt to 0°.
    const to2d = await recordTilt(page, () => tap(page, button('2d')));
    expect(await tiltState(page)).toMatchObject({ mode: '2d', tilt: 0 });
    expectSmooth(to2d, 0);
    await expect(button('2d')).toHaveAttribute('aria-pressed', 'true');

    // Keyboard: from the pressed button, the arrows move to 3D and Enter chooses it; Back to Auto by Enter.
    await press(button('2d'), 'ArrowRight');
    await expect(button('3d')).toBeFocused();
    await page.keyboard.press('Enter');
    await waitForIdle(page);
    expect((await tiltState(page)).tilt).toBeCloseTo(state3d.tilt, 1);
    const toAuto = await recordTilt(page, () => press(back, 'Enter'));
    expect((await tiltState(page)).mode).toBe('auto');
    expectSmooth(toAuto, autoTilt);
    await expect(back).toBeHidden();
    await expect(button('auto')).toHaveAttribute('aria-pressed', 'true');

    // A manual tilt shows as 3D, and Back to Auto restores the curves.
    await page.evaluate(() => window.vibeglobePlayground?.globe.tiltTo(40, { durationMs: 0 }));
    await waitForIdle(page);
    await expect(button('3d')).toHaveAttribute('aria-pressed', 'true');
    await back.click();
    await waitForIdle(page);
    expect((await tiltState(page)).mode).toBe('auto');
    await expect(button('auto')).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('the tilt control (F422)', () => {
  test('sets the chosen tilt by mouse drag, touch and keys; it persists across zoom and shows a clamp', async ({
    page,
  }) => {
    await openUi(page, { query: 'backend=webgl2&lon=7.6&lat=45.9&zoom=12' });
    await waitForIdle(page);
    const slider = page.locator('.vg-ui__tilt-track');
    const box = await slider.boundingBox();
    if (box === null) throw new Error('no slider');
    // Mouse: press near the bottom and drag up to about two thirds of the track.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 2);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++)
      await page.mouse.move(box.x + box.width / 2, box.y + box.height * (1 - (0.66 * i) / 5));
    await page.mouse.up();
    await waitForIdle(page);
    const dragged = await tiltState(page);
    expect(dragged.mode).toBe('manual');
    expect(dragged.chosen).toBeGreaterThan(45);
    expect(dragged.chosen).toBeLessThan(65);
    await expect(slider).toHaveAttribute('aria-valuenow', String(Math.round(dragged.tilt)));

    // Keyboard: an arrow press eases the chosen tilt by 5°.
    const keyed = await recordTilt(page, () => press(slider, 'ArrowDown'));
    expect((await tiltState(page)).chosen).toBeCloseTo(dragged.chosen - 5, 6);
    expectSmooth(keyed, dragged.chosen - 5);

    // Touch: a tap low on the track chooses a small tilt.
    await touch(page, box.x + box.width / 2, box.y + box.height * 0.85);
    await waitForIdle(page);
    const tapped = await tiltState(page);
    expect(tapped.chosen).toBeGreaterThan(5);
    expect(tapped.chosen).toBeLessThan(20);

    // The chosen tilt persists across zoom.
    await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ zoom: 9 }));
    await waitForIdle(page);
    expect((await tiltState(page)).chosen).toBeCloseTo(tapped.chosen, 6);

    // Zoomed out to the globe with a steep choice, a clamp holds the applied tilt below it, and the slider says so.
    await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ zoom: 3, tiltDeg: 80 }));
    await waitForIdle(page);
    const clamped = await tiltState(page);
    expect(clamped.chosen).toBe(80);
    expect(clamped.tilt).toBeLessThan(79.5);
    await expect(slider).toHaveAttribute('data-clamped', 'true');
    await expect(slider).toHaveAttribute('aria-valuetext', new RegExp(`limited from the chosen 80°`));
  });
});

test.describe('reset to globe and home (F423)', () => {
  test('fly to the globe and home with mouse, touch and keyboard; input interrupts; reduced motion fades', async ({
    page,
  }) => {
    await openUi(page, { query: 'backend=webgl2&lon=7.6&lat=45.9&zoom=6' });
    await page.evaluate(() =>
      window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: 12, latitudeDeg: 42, zoom: 10 }),
    );
    await waitForIdle(page);
    const outcomes = async (action: () => Promise<void>): Promise<string[]> => {
      await page.evaluate(() => {
        const list: string[] = [];
        (window as unknown as { moves: string[] }).moves = list;
        const globe = window.vibeglobePlayground?.globe;
        // Only the controls' movements: a drag's own movement (and its inertia) ends with cause 'user'.
        const stop = globe?.on('moveend', ({ outcome, cause }) => {
          if (cause !== 'api') return;
          list.push(`${cause}:${outcome}`);
          stop?.();
        });
      });
      await action();
      await page.waitForFunction(() => (window as unknown as { moves: string[] }).moves.length > 0);
      return page.evaluate(() => (window as unknown as { moves: string[] }).moves);
    };
    expect(await outcomes(() => page.locator('.vg-ui__button--reset-globe').click())).toEqual(['api:completed']);
    const zoomOut = await page.evaluate(() => window.vibeglobePlayground?.globe.camera.zoom ?? NaN);
    expect(zoomOut).toBeLessThan(4);
    expect(await outcomes(() => tap(page, page.locator('.vg-ui__button--home')))).toEqual(['api:completed']);
    const home = await page.evaluate(() => window.vibeglobePlayground?.globe.camera);
    expect(home?.longitudeDeg).toBeCloseTo(7.6, 6);
    expect(home?.zoom).toBeCloseTo(6, 6);
    // Keyboard, and a drag on the map interrupts the flight.
    expect(
      await outcomes(async () => {
        await press(page.locator('.vg-ui__button--reset-globe'), 'Enter');
        await nextFrame(page);
        await page.mouse.move(320, 300);
        await page.mouse.down();
        await page.mouse.move(360, 320, { steps: 4 });
        await page.mouse.up();
      }),
    ).toEqual(['api:interrupted']);
    // Reduced motion: the flight is a quick fade.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const started = await page.evaluate(() => window.vibeglobePlayground?.globe.timeMs ?? 0);
    expect(await outcomes(() => page.locator('.vg-ui__button--home').click())).toEqual(['api:completed']);
    const took = (await page.evaluate(() => window.vibeglobePlayground?.globe.timeMs ?? 0)) - started;
    expect(took).toBeLessThan(800);
  });
});

test.describe('the attribution control (F424)', () => {
  test('lists the visible sources’ credits within one frame, collapses on narrow maps, links focusable', async ({
    page,
  }) => {
    const session = await fixtureSession(page);
    await openUi(page, {
      query: `backend=webgl2&imagery=smooth&overlays=patches:0.5&overlayCoverage=italy&requiredCredit=fixture-smooth&session=${session}&lon=12.5&lat=41.9&zoom=8`,
    });
    await waitForImagery(page);
    const items = page.locator('.vg-ui__attribution .vg-ui__credit-text');
    await expect(items).toHaveText(['Required smooth', 'Fixture smooth', 'Fixture patches']);
    // Within one frame: on every drawn frame the control's list equals the engine's credits.
    await page.evaluate(() => {
      const globe = window.vibeglobePlayground?.globe;
      const mismatches: string[] = [];
      (window as unknown as { mismatches: string[] }).mismatches = mismatches;
      globe?.on('frame', () => {
        const shown = [...document.querySelectorAll('.vg-ui__attribution .vg-ui__credit-text')].map(
          (e) => e.textContent,
        );
        const engine = (globe.credits() ?? []).map((c) => c.text);
        if (shown.join('|') !== engine.join('|')) mismatches.push(`${shown.join('|')} != ${engine.join('|')}`);
      });
      globe?.jumpTo({ longitudeDeg: 2.35, latitudeDeg: 48.85 });
    });
    await waitForImagery(page);
    await expect(items).toHaveText(['Required smooth', 'Fixture smooth']);
    expect(await page.evaluate(() => (window as unknown as { mismatches: string[] }).mismatches)).toEqual([]);
    const link = page.locator('.vg-ui__attribution a', { hasText: 'Fixture smooth' });
    await expect(link).toHaveAttribute('href', 'https://example.com/fixtures/smooth');
    await link.focus();
    await expect(link).toBeFocused();
    await expect(page.locator('.vg-ui__attribution')).toHaveAttribute('role', 'contentinfo');

    // Narrow map: collapsed to the required credit and its logo, expandable with touch and the keyboard.
    await page.setViewportSize({ width: 400, height: 480 });
    const toggle = page.locator('.vg-ui__button--attribution');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.vg-ui__credit--required img')).toBeVisible();
    await expect(page.locator('.vg-ui__credit:not(.vg-ui__credit--required)')).toBeHidden();
    await tap(page, toggle);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.vg-ui__credit:not(.vg-ui__credit--required)')).toBeVisible();
    await press(toggle, 'Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });
});

test.describe('the layer switcher (F425)', () => {
  test('chooses the base map and toggles overlays with mouse, touch and keyboard, and follows runtime layers', async ({
    page,
  }) => {
    const session = await fixtureSession(page);
    await openUi(page, {
      query: `backend=webgl2&imagery=smooth&overlays=patches:1,stripes:0.5&session=${session}&lon=12.5&lat=41.9&zoom=5`,
    });
    await loadLayers(page);
    await page.evaluate(() => {
      const handle = window.vibeglobeUi;
      const globe = window.vibeglobePlayground?.globe;
      if (handle?.layers === undefined || globe === undefined) throw new Error('no ui');
      const data = handle.layers.createGlobeLayers(globe);
      (window as unknown as { dataLayers: typeof data }).dataLayers = data;
      handle.layer.replace(
        new handle.ui.LayerSwitcherControl({
          overlays: ['overlay-stripes'],
          names: { 'fixture-smooth': 'Smooth', 'overlay-patches': 'Patches', 'overlay-stripes': 'Stripes' },
          dataLayers: data,
        }),
      );
    });
    await waitForImagery(page);
    const button = page.locator('.vg-ui__button--layers');
    await button.click();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    const panel = page.locator('.vg-ui__layers-panel');
    await expect(panel.getByRole('radio')).toHaveCount(2);
    await expect(panel.getByRole('checkbox')).toHaveCount(1);
    const visible = (): Promise<Record<string, boolean>> =>
      page.evaluate(() =>
        Object.fromEntries(
          (window.vibeglobePlayground?.globe.imageryLayers.list() ?? []).map((l) => [l.id, l.visible]),
        ),
      );
    // Mouse: the Smooth base map hides Patches.
    await panel.getByRole('radio', { name: 'Smooth' }).click();
    await waitForImagery(page);
    expect(await visible()).toEqual({ 'fixture-smooth': true, 'overlay-patches': false, 'overlay-stripes': true });
    await expectNoBlack(page);
    // Touch: the Stripes overlay off.
    await tap(page, panel.getByRole('checkbox', { name: 'Stripes' }));
    await waitForImagery(page);
    expect((await visible())['overlay-stripes']).toBe(false);
    await expectNoBlack(page);
    // Keyboard: arrows move through the base maps (and choose), Space toggles a check box, Escape closes.
    await press(panel.getByRole('radio', { name: 'Smooth' }), 'ArrowDown');
    await waitForImagery(page);
    expect(await visible()).toMatchObject({ 'fixture-smooth': false, 'overlay-patches': true });
    await press(panel.getByRole('checkbox', { name: 'Stripes' }), 'Space');
    expect((await visible())['overlay-stripes']).toBe(true);
    await expectNoBlack(page);

    // Data layers added and removed at runtime appear and disappear while the panel is open.
    await page.evaluate(() => {
      const { dataLayers } = window as unknown as { dataLayers: import('@vibeglobe/layers').GlobeLayers };
      const layers = window.vibeglobeUi?.layers;
      if (layers === undefined) throw new Error('no layers');
      dataLayers.stack.add(layers.pointLayer({ id: 'runtime-points' }));
    });
    await expect(panel.getByRole('checkbox', { name: 'runtime-points' })).toBeVisible();
    await panel.getByRole('checkbox', { name: 'runtime-points' }).click();
    expect(
      await page.evaluate(() =>
        (window as unknown as { dataLayers: import('@vibeglobe/layers').GlobeLayers }).dataLayers.stack.isVisible(
          'runtime-points',
        ),
      ),
    ).toBe(false);
    await page.evaluate(() =>
      (window as unknown as { dataLayers: import('@vibeglobe/layers').GlobeLayers }).dataLayers.stack.remove(
        'runtime-points',
      ),
    );
    await expect(panel.getByRole('checkbox', { name: 'runtime-points' })).toHaveCount(0);
    await press(panel.getByRole('radio').first(), 'Escape');
    await expect(button).toHaveAttribute('aria-expanded', 'false');
    await expect(button).toBeFocused();
  });
});

/** No pixel of the drawn globe is black (a missing tile): every canvas pixel inside the globe has some color. */
async function expectNoBlack(page: Page): Promise<void> {
  const black = await page.evaluate(async () => {
    const globe = window.vibeglobePlayground?.globe;
    if (globe === undefined) throw new Error('no globe');
    const frame = await globe.captureFrame();
    const { rgba } = frame;
    let count = 0;
    for (let i = 0; i < rgba.length; i += 4)
      if ((rgba[i + 3] ?? 0) < 255 || (rgba[i] ?? 0) + (rgba[i + 1] ?? 0) + (rgba[i + 2] ?? 0) === 0) count += 1;
    return count;
  });
  expect(black).toBe(0);
}

test.describe('the scale bar (F412)', () => {
  /** The geodesic length across the bar's screen width at the view center, and the length the bar states. */
  async function check(page: Page): Promise<{ statedMeters: number; groundMeters: number }> {
    return page.evaluate(() => {
      const handle = window.vibeglobeUi;
      const globe = window.vibeglobePlayground?.globe;
      const app = document.getElementById('app');
      if (handle === undefined || globe === undefined || app === null) throw new Error('no ui');
      const control = handle.layer.get('scale') as InstanceType<typeof handle.ui.ScaleBarControl>;
      const bar = document.querySelector<HTMLElement>('.vg-ui__scale-bar');
      const width = bar?.getBoundingClientRect().width ?? 0;
      const cx = app.clientWidth / 2;
      const cy = app.clientHeight / 2;
      const left = globe.screenToGeo({ xPx: cx - width / 2, yPx: cy });
      const right = globe.screenToGeo({ xPx: cx + width / 2, yPx: cy });
      if (left === undefined || right === undefined) throw new Error('off the globe');
      return {
        statedMeters: control.measurement?.lengthMeters ?? NaN,
        groundMeters: handle.gis.measureDistance(left, right).distanceMeters,
      };
    });
  }

  for (const [phase, setup] of [
    ['globe', 'zoom=2.5'],
    ['2D', 'zoom=12&viewMode=2d'],
    ['tilted 3D', 'zoom=12&tilt=60'],
  ] as const)
    test(`matches the ground distance at the view center within 1% in the ${phase} phase`, async ({ page }) => {
      await openUi(page, { query: `backend=webgl2&lon=7.6&lat=45.9&${setup}` });
      await waitForIdle(page);
      const { statedMeters, groundMeters } = await check(page);
      expect(Math.abs(statedMeters - groundMeters) / groundMeters).toBeLessThan(0.01);
      const label = await page.locator('.vg-ui__scale').getAttribute('aria-label');
      expect(label).toMatch(/^Map scale: the bar is [\d.,]+ k?m long$/);
    });

  test('updates in the frame of each camera change, and is reachable by keyboard focus', async ({ page }) => {
    await openUi(page, { query: 'backend=webgl2&lon=7.6&lat=45.9&zoom=10' });
    await waitForIdle(page);
    const stale = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const globe = window.vibeglobePlayground?.globe;
          const handle = window.vibeglobeUi;
          if (globe === undefined || handle === undefined) throw new Error('no ui');
          const control = handle.layer.get('scale') as InstanceType<typeof handle.ui.ScaleBarControl>;
          let wrong = 0;
          // In the frame's camera event, after the control's handler, the bar describes that frame's view.
          const stop = globe.on('camera-change', () => {
            const app = document.getElementById('app') as HTMLElement;
            const fresh = handle.ui.measureScale(globe, { xPx: app.clientWidth / 2, yPx: app.clientHeight / 2 }, 100);
            if (fresh?.lengthMeters !== control.measurement?.lengthMeters) wrong += 1;
          });
          void globe.easeTo({ zoom: 14 }, { durationMs: 1500 }).then(() => {
            stop();
            resolve(wrong);
          });
        }),
    );
    expect(stale).toBe(0);
    await page.locator('.vg-ui__scale').focus();
    await expect(page.locator('.vg-ui__scale')).toBeFocused();
  });
});

test.describe('geolocation (F413)', () => {
  test('shows the position and its accuracy, flies there, follows it, with mouse, touch and keyboard', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: 45.07, longitude: 7.69, accuracy: 300 });
    await openUi(page, { query: 'backend=webgl2&lon=0&lat=20&zoom=3&tilt=30' });
    const button = page.locator('.vg-ui__button--geolocate');
    for (const how of ['mouse', 'touch', 'keyboard'] as const) {
      if (how === 'mouse') await button.click();
      else if (how === 'touch') await tap(page, button);
      else await press(button, 'Enter');
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.vg-ui__geolocation .vg-ui__status')).toHaveText(/accurate to 300 m/);
      await page.waitForFunction(() => {
        const camera = window.vibeglobePlayground?.globe.camera;
        return camera !== undefined && Math.abs(camera.longitudeDeg - 7.69) < 1e-6 && Math.abs(camera.zoom - 15) < 1e-6;
      });
      await waitForIdle(page);
      // The flight kept the chosen tilt (manual mode from the start view).
      expect((await tiltState(page)).chosen).toBeCloseTo(30, 6);
      expect(await markerColorAt(page, 7.69, 45.07)).toBe(true);
      if (how !== 'keyboard') {
        await button.click();
        await expect(button).toHaveAttribute('aria-pressed', 'false');
        await page.evaluate(() =>
          window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: 0, latitudeDeg: 20, zoom: 3 }),
        );
      }
    }
    // The marker follows a new position; the camera stays.
    await context.setGeolocation({ latitude: 45.071, longitude: 7.692, accuracy: 300 });
    await page.waitForFunction(() => document.querySelector('.vg-ui__geolocation .vg-ui__status') !== null);
    await page.waitForTimeout(500);
    await waitForIdle(page);
    expect(await markerColorAt(page, 7.692, 45.071)).toBe(true);
    const camera = await page.evaluate(() => window.vibeglobePlayground?.globe.camera.longitudeDeg);
    expect(camera).toBeCloseTo(7.69, 6);
  });

  test('a denied permission shows a translated message and the engine keeps working', async ({ page, context }) => {
    await context.clearPermissions();
    await openUi(page, { query: 'backend=webgl2&lon=7&lat=45&zoom=5', language: 'it' });
    await page.evaluate(() => {
      // Chromium's headless prompt answers nothing: deny as a user would.
      navigator.geolocation.watchPosition = (_ok, error) => {
        error?.({
          code: 1,
          PERMISSION_DENIED: 1,
          POSITION_UNAVAILABLE: 2,
          TIMEOUT: 3,
          message: 'denied',
        } as GeolocationPositionError);
        return 1;
      };
    });
    await page.locator('.vg-ui__button--geolocate').click();
    await expect(page.locator('.vg-ui__geolocation .vg-ui__status')).toHaveText(
      "L'accesso alla posizione è stato negato",
    );
    const before = await page.evaluate(() => window.vibeglobePlayground?.globe.frameNumber ?? 0);
    await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ zoom: 6 }));
    await waitForIdle(page);
    expect(await page.evaluate(() => window.vibeglobePlayground?.globe.frameNumber ?? 0)).toBeGreaterThan(before);
  });
});

/** Whether the frame shows the marker's blue at a position's screen point. */
async function markerColorAt(page: Page, longitudeDeg: number, latitudeDeg: number): Promise<boolean> {
  return page.evaluate(
    async ([lon, lat]) => {
      const globe = window.vibeglobePlayground?.globe;
      if (globe === undefined) throw new Error('no globe');
      const point = globe.geoToScreen({ longitudeDeg: lon, latitudeDeg: lat });
      const frame = await globe.captureFrame();
      if (point === undefined) return false;
      const scale = frame.widthPx / (document.getElementById('app')?.clientWidth ?? frame.widthPx);
      const x = Math.round(point.xPx * scale);
      const y = Math.round(point.yPx * scale);
      const i = (y * frame.widthPx + x) * 4;
      const [r, g, b] = [frame.rgba[i] ?? 0, frame.rgba[i + 1] ?? 0, frame.rgba[i + 2] ?? 0];
      // #1a73e8: blue well above red and green.
      return b > 150 && b > r + 60 && b > g + 30;
    },
    [longitudeDeg, latitudeDeg] as const,
  );
}
