import { expect, test, type Page } from '@playwright/test';
import {
  cameraOf,
  consoleProblems,
  drag,
  eventsOf,
  expectRenderedGlobe,
  openExample,
  waitForEvent,
} from './support/adapters.ts';
import { touch } from './support/ui-layer.ts';

// The `<vibe-globe>` element: in a plain HTML page that loads its browser build with no bundler
// (apps/adapter-examples/public/plain.html), and inside a React and a Vue app.

async function middle(page: Page, selector = 'vibe-globe'): Promise<{ x: number; y: number }> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no ${selector}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`the element works in a plain HTML page with no bundler on ${backend} (F481)`, async ({ browser }) => {
    const context = await browser.newContext({ hasTouch: true });
    const page = await context.newPage();
    const problems = consoleProblems(page);
    const scripts: string[] = [];
    page.on('request', (request) => {
      if (request.resourceType() === 'script') scripts.push(new URL(request.url()).pathname);
    });
    await openExample(page, `plain.html?backend=${backend}`);
    expect(await page.evaluate(() => window.adapterExample?.globes()[0]?.backend)).toBe(backend);
    // Only the static browser build is loaded: no dev-server module graph, no source files.
    expect(scripts.every((path) => path.startsWith('/wc/'))).toBe(true);
    await expectRenderedGlobe(page);

    const { x, y } = await middle(page);
    const start = await cameraOf(page);
    await drag(page, x, y, -100, 0);
    const afterMouse = await cameraOf(page);
    expect(afterMouse.longitudeDeg).toBeGreaterThan(start.longitudeDeg + 1);
    await touch(page, x, y, 100);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect((await cameraOf(page)).longitudeDeg).toBeLessThan(afterMouse.longitudeDeg - 1);
    expect(problems).toEqual([]);
    await context.close();
  });
}

test('attributes and properties configure and update the engine, and events carry typed details (F482)', async ({
  page,
}) => {
  await openExample(page, 'plain.html?backend=webgl2');
  // The initial view comes from the attributes `center="12.5, 41.9" zoom="3"`.
  expect(await cameraOf(page)).toEqual({
    longitudeDeg: expect.closeTo(12.5, 6),
    latitudeDeg: expect.closeTo(41.9, 6),
    zoom: expect.closeTo(3, 6),
  });
  expect((await waitForEvent(page, 'ready')).payload).toEqual({ backend: 'webgl2' });
  await waitForEvent(page, 'load');
  await page.evaluate(() => {
    const element = document.querySelector('vibe-globe') as HTMLElement & { globe: unknown };
    (window as unknown as { kept: unknown[] }).kept = [element.globe, element.shadowRoot?.querySelector('canvas')];
  });

  // Attributes from script.
  await page.evaluate(() => {
    const element = document.querySelector('vibe-globe');
    element?.setAttribute('center', '-3.7, 40.4');
    element?.setAttribute('zoom', '5');
    element?.setAttribute('heading-deg', '30');
  });
  const camera = await page.evaluate(() => window.adapterExample?.globes()[0]?.camera);
  expect(camera?.longitudeDeg).toBeCloseTo(-3.7, 6);
  expect(camera?.latitudeDeg).toBeCloseTo(40.4, 6);
  expect(camera?.zoom).toBeCloseTo(5, 6);
  expect(camera?.headingDeg).toBeCloseTo(30, 6);
  // Properties reflect to attributes and move the engine.
  const reflected = await page.evaluate(() => {
    const element = document.querySelector('vibe-globe') as HTMLElement & {
      center: unknown;
      zoom: number;
      tiltDeg: number;
    };
    element.center = { longitudeDeg: 2.35, latitudeDeg: 48.86 };
    element.zoom = 6;
    element.tiltDeg = 20;
    return { center: element.getAttribute('center'), zoom: element.getAttribute('zoom'), read: element.center };
  });
  expect(reflected).toEqual({
    center: '2.35, 48.86',
    zoom: '6',
    read: { longitudeDeg: 2.35, latitudeDeg: 48.86 },
  });
  expect(await cameraOf(page)).toEqual({
    longitudeDeg: expect.closeTo(2.35, 6),
    latitudeDeg: expect.closeTo(48.86, 6),
    zoom: expect.closeTo(6, 6),
  });
  expect(await page.evaluate(() => window.adapterExample?.globes()[0]?.camera.tiltDeg)).toBeCloseTo(20, 6);
  // No remount: the same engine and canvas, one ready event.
  const same = await page.evaluate(() => {
    const element = document.querySelector('vibe-globe') as HTMLElement & { globe: unknown };
    const [globe, canvas] = (window as unknown as { kept: unknown[] }).kept;
    return globe === element.globe && canvas === element.shadowRoot?.querySelector('canvas');
  });
  expect(same).toBe(true);
  expect(await eventsOf(page, 'ready')).toHaveLength(1);

  // camera-change and globe-click arrive as CustomEvents with typed details.
  await expect
    .poll(async () => ((await eventsOf(page, 'camera-change')).at(-1)?.payload as { zoom: number }).zoom)
    .toBeCloseTo(6, 6);
  const { x, y } = await middle(page);
  await page.mouse.click(x, y);
  const click = (await waitForEvent(page, 'globe-click')).payload as {
    position: { longitudeDeg: number; latitudeDeg: number };
  };
  expect(click.position.longitudeDeg).toBeCloseTo(2.35, 0);
  expect(click.position.latitudeDeg).toBeCloseTo(48.86, 0);
  // The full engine API through the element.
  expect(await page.evaluate(() => typeof window.adapterExample?.globes()[0]?.screenToGeo)).toBe('function');
});

test('the element registers under a custom tag name (F483)', async ({ page }) => {
  await openExample(page, 'plain.html?backend=webgl2');
  const backend = await page.evaluate(async () => {
    const module = (await import('/wc/vibe-globe.js' as string)) as {
      defineVibeGlobe(tag: string): new () => HTMLElement;
    };
    const ViewClass = module.defineVibeGlobe('earth-view');
    const element = document.createElement('earth-view') as HTMLElement & {
      globe: { ready: Promise<void>; backend: string } | undefined;
    };
    element.setAttribute('base-imagery-url', '/imagery/natural-earth-4096.jpg');
    element.setAttribute('backend', 'webgl2');
    element.setAttribute('zoom', '2');
    element.style.cssText = 'position:fixed;inset:0;width:50vw;height:50vh';
    document.body.append(element);
    await element.globe?.ready;
    return { backend: element.globe?.backend, instance: element instanceof ViewClass };
  });
  expect(backend).toEqual({ backend: 'webgl2', instance: true });
});

for (const [host, path] of [
  ['React', 'react.html'],
  ['Vue', 'vue-element.html'],
] as const) {
  test(`the element renders and emits events inside a ${host} app (F483)`, async ({ page }) => {
    const problems = consoleProblems(page);
    await openExample(page, `${path}?backend=webgl2`);
    await waitForEvent(page, 'ready');
    await waitForEvent(page, 'load');
    await expectRenderedGlobe(page);
    const { x, y } = await middle(page);
    await drag(page, x, y, -80, 0);
    expect((await eventsOf(page, 'camera-change')).length).toBeGreaterThan(0);
    await page.mouse.click(x, y);
    await waitForEvent(page, 'globe-click');
    expect(problems).toEqual([]);
  });
}

test('removing the element stops its engine, re-inserting and moving it work (F484)', async ({ page }) => {
  const problems = consoleProblems(page);
  await openExample(page, 'plain.html?backend=webgl2');
  const removed = await page.evaluate(async () => {
    const element = document.querySelector('vibe-globe') as HTMLElement & {
      globe: { ready: Promise<void>; resourceCounts(): { contexts: number } } | undefined;
    };
    const first = element.globe;
    element.remove();
    await Promise.resolve();
    await Promise.resolve();
    return { gone: element.globe === undefined, contexts: first?.resourceCounts().contexts };
  });
  expect(removed.gone).toBe(true);
  expect(removed.contexts).toBe(0);
  await page.evaluate(() => window.adapterExample?.show(true));
  await page.evaluate(() => window.adapterExample?.globes()[0]?.ready);
  await expectRenderedGlobe(page);
  // Moved to another parent within one task: the same engine keeps drawing.
  const moved = await page.evaluate(async () => {
    const element = document.querySelector('vibe-globe') as HTMLElement & { globe: unknown };
    const before = element.globe;
    const parent = document.createElement('div');
    parent.style.cssText = 'position:fixed;inset:0';
    document.body.append(parent);
    parent.append(element);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return element.globe === before && element.parentElement === parent;
  });
  expect(moved).toBe(true);
  const { x, y } = await middle(page);
  const before = await cameraOf(page);
  await drag(page, x, y, -100, 0);
  expect((await cameraOf(page)).longitudeDeg).toBeGreaterThan(before.longitudeDeg + 1);
  await expectRenderedGlobe(page);
  expect(problems).toEqual([]);
});
