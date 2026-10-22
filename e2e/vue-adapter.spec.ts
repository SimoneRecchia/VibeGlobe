import { expect, test } from '@playwright/test';
import {
  cameraOf,
  consoleProblems,
  drag,
  eventsOf,
  expectRenderedGlobe,
  openExample,
  waitForEvent,
} from './support/adapters.ts';

// The Vue 3 adapter in the minimal Vite + Vue example (apps/adapter-examples/src/App.vue). vue-tsc rejecting a
// wrongly typed prop (F473) is checked by the example's build (`@vue-expect-error` in App.vue, `npm run build`).

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`the Vue component renders the globe and re-emits typed engine events on ${backend} (F473)`, async ({
    page,
  }) => {
    const problems = consoleProblems(page);
    await openExample(page, `?backend=${backend}`);
    expect(await page.evaluate(() => window.adapterExample?.globes()[0]?.backend)).toBe(backend);
    const ready = await waitForEvent(page, 'ready', 'first');
    expect(ready.payload).toEqual({ backend });
    await waitForEvent(page, 'load', 'first');
    await expectRenderedGlobe(page);
    await expect(page.locator('[data-vibeglobe-placeholder]')).toHaveCount(0);

    // Camera: a drag moves the camera and every listener gets the engine's camera state.
    const box = await page.locator('.vibeglobe').first().boundingBox();
    if (!box) throw new Error('no globe element');
    const before = await cameraOf(page);
    await drag(page, box.x + box.width / 2, box.y + box.height / 2, -120, 0);
    const after = await cameraOf(page);
    expect(after.longitudeDeg).toBeGreaterThan(before.longitudeDeg + 1);
    const cameras = await eventsOf(page, 'camera-change', 'first');
    expect(cameras.length).toBeGreaterThan(0);
    const last = cameras.at(-1)?.payload as Record<string, unknown>;
    for (const field of ['longitudeDeg', 'latitudeDeg', 'zoom', 'headingDeg', 'tiltDeg', 'altitudeMeters'])
      expect(typeof last[field]).toBe('number');
    expect(last['longitudeDeg']).toBeCloseTo(after.longitudeDeg, 6);

    // Click: a click at the middle of the globe reports the point and the position under it.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    const click = (await waitForEvent(page, 'globe-click', 'first')).payload as {
      point: { xPx: number; yPx: number };
      position: { longitudeDeg: number; latitudeDeg: number };
    };
    expect(click.point.xPx).toBeCloseTo(box.width / 2, 0);
    expect(click.point.yPx).toBeCloseTo(box.height / 2, 0);
    const center = await cameraOf(page);
    expect(click.position.longitudeDeg).toBeCloseTo(center.longitudeDeg, 0);
    expect(click.position.latitudeDeg).toBeCloseTo(center.latitudeDeg, 0);
    expect(problems).toEqual([]);
  });
}

test('changing the camera props moves the running engine without a remount (F474, camera)', async ({ page }) => {
  await openExample(page, '?backend=webgl2');
  await page.evaluate(() => {
    const globe = window.adapterExample?.globes()[0];
    (window as unknown as { kept: unknown[] }).kept = [globe, document.querySelector('.vibeglobe canvas')];
  });
  await page.evaluate(() => window.adapterExample?.setView({ longitudeDeg: -3.7, latitudeDeg: 40.4, zoom: 5 }));
  await expect
    .poll(() => cameraOf(page))
    .toEqual({
      longitudeDeg: expect.closeTo(-3.7, 6),
      latitudeDeg: expect.closeTo(40.4, 6),
      zoom: expect.closeTo(5, 6),
    });
  const same = await page.evaluate(() => {
    const [globe, canvas] = (window as unknown as { kept: unknown[] }).kept;
    return globe === window.adapterExample?.globes()[0] && canvas === document.querySelector('.vibeglobe canvas');
  });
  expect(same).toBe(true);
  expect(await eventsOf(page, 'ready', 'first')).toHaveLength(1);
});

test('the camera composable follows navigation and updates at most once per frame (F475, camera)', async ({ page }) => {
  await openExample(page, '?backend=webgl2');
  const box = await page.locator('.vibeglobe').first().boundingBox();
  if (!box) throw new Error('no globe element');
  const matches = async (): Promise<void> => {
    await expect
      .poll(async () => {
        const shown = await page.evaluate(() => window.adapterExample?.displayed?.());
        const camera = await cameraOf(page);
        return (
          Math.abs(Number(shown?.['longitudeDeg']) - camera.longitudeDeg) < 1e-9 &&
          Math.abs(Number(shown?.['latitudeDeg']) - camera.latitudeDeg) < 1e-9 &&
          Math.abs(Number(shown?.['zoom']) - camera.zoom) < 1e-9
        );
      })
      .toBe(true);
  };
  await drag(page, box.x + box.width / 2, box.y + box.height / 2, 80, 40);
  await matches();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -400);
  await matches();
  // Batched: the readout re-renders no more often than the page draws frames during a drag.
  const counts = await page.evaluate(async () => {
    const start = Number(window.adapterExample?.displayed?.()['updates']);
    let frames = 0;
    let running = true;
    const count = (): void => {
      frames++;
      if (running) requestAnimationFrame(count);
    };
    requestAnimationFrame(count);
    const element = document.querySelector('.vibeglobe');
    const rect = element?.getBoundingClientRect();
    if (!element || !rect) throw new Error('no globe element');
    const at = (x: number): PointerEventInit => ({
      clientX: rect.left + x,
      clientY: rect.top + rect.height / 2,
      bubbles: true,
      pointerId: 1,
      isPrimary: true,
      button: 0,
      buttons: 1,
    });
    const target = element.querySelector('canvas') ?? element;
    target.dispatchEvent(new PointerEvent('pointerdown', at(rect.width / 2)));
    for (let i = 0; i < 30; i++) {
      target.dispatchEvent(new PointerEvent('pointermove', at(rect.width / 2 + i * 4)));
      target.dispatchEvent(new PointerEvent('pointermove', at(rect.width / 2 + i * 4 + 2)));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    target.dispatchEvent(new PointerEvent('pointerup', at(rect.width / 2 + 120)));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    running = false;
    return { updates: Number(window.adapterExample?.displayed?.()['updates']) - start, frames };
  });
  expect(counts.updates).toBeGreaterThan(0);
  expect(counts.updates).toBeLessThanOrEqual(counts.frames);
  await matches();
});

test('two Vue globes on one page run independent engines (F479)', async ({ page }) => {
  const problems = consoleProblems(page);
  await openExample(page, '?backend=webgl2&two=1&imagery=1', 2);
  await expectRenderedGlobe(page, 0);
  await expectRenderedGlobe(page, 1);
  const secondBefore = await cameraOf(page, 1);
  const boxes = await page.locator('.vibeglobe').all();
  const first = await boxes[0]?.boundingBox();
  if (!first) throw new Error('no first globe');
  await drag(page, first.x + first.width / 2, first.y + first.height / 2, -100, 30);
  expect(await cameraOf(page, 1)).toEqual(secondBefore);
  const firstAfter = await cameraOf(page, 0);
  expect(firstAfter.longitudeDeg).not.toBeCloseTo(12.5, 1);
  // Each engine streams its own source.
  const sources = await page.evaluate(() =>
    (window.adapterExample?.globes() ?? []).map((globe) => globe?.imageryStats()?.requested ?? 0),
  );
  expect(sources[0]).toBeGreaterThan(0);
  expect(sources[1]).toBeGreaterThan(0);
  // Unmounting the first leaves the second rendering.
  await page.evaluate(() => window.adapterExample?.show(false, 0));
  expect(await page.evaluate(() => window.adapterExample?.globes()[0])).toBeUndefined();
  await page.evaluate(async () => {
    const second = window.adapterExample?.globes()[1];
    second?.requestRender();
    await second?.captureFrame();
  });
  await expectRenderedGlobe(page, 1);
  expect(await cameraOf(page, 1)).toEqual(secondBefore);
  expect(problems).toEqual([]);
});
