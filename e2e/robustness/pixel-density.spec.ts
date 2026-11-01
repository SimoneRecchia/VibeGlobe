// Pixel-density changes (F514): the device pixel ratio changes from 1 to 2 and back while the engine runs (CDP
// emulation, as when the window moves between a 1x and a 2x monitor), with labelled vector tiles in view. The canvas
// takes the new resolution within one frame, no frame in between is blank, and the settled frame matches a page that
// started at the new density. Headless emulation dispatches no media query events, so the spec delivers the ones a
// real change dispatches; moving a real window between monitors is a manual step (docs/internal/hardening-backlog.md).
import { expect, test, type Browser, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage } from '../support/globe.ts';
import { openVector, settle } from '../vector-tiles/support.ts';
import { collectErrors, unexpected } from './support/probes.ts';

const BACKENDS = ['webgpu', 'webgl2'] as const;
const VIEWPORT = { width: 320, height: 240 };

/** The canvas's size in device pixels against its CSS size times `ratio`. */
async function canvasSize(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('#globe');
    return { width: canvas?.width, height: canvas?.height, cssWidth: canvas?.clientWidth, ratio: devicePixelRatio };
  });
}

/**
 * Records every media query list the page creates, with its last result, so `setRatio` can deliver the `change`
 * events a real ratio change dispatches: under CDP emulation headless Chromium updates `devicePixelRatio` and the
 * queries' results but dispatches neither those events nor a new device-pixel resize observation.
 */
function recordMediaQueries(): void {
  const lists: { list: MediaQueryList; matches: boolean }[] = [];
  const original = window.matchMedia.bind(window);
  window.matchMedia = (query: string) => {
    const list = original(query);
    lists.push({ list, matches: list.matches });
    return list;
  };
  (window as unknown as { deliverMediaChanges: () => number }).deliverMediaChanges = () => {
    let delivered = 0;
    for (const entry of lists) {
      if (entry.list.matches === entry.matches) continue;
      entry.matches = entry.list.matches;
      entry.list.dispatchEvent(new MediaQueryListEvent('change', { matches: entry.matches, media: entry.list.media }));
      delivered++;
    }
    return delivered;
  };
}

/** Sets the emulated device pixel ratio of a page and delivers the media query changes a real change dispatches. */
async function setRatio(page: Page, deviceScaleFactor: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { ...VIEWPORT, deviceScaleFactor, mobile: false });
  const delivered = await page.evaluate(() =>
    (window as unknown as { deliverMediaChanges: () => number }).deliverMediaChanges(),
  );
  // The engine watches the query of the current ratio (`browser-host.ts`): its change is what it reacts to.
  expect(delivered).toBeGreaterThan(0);
}

/** Waits for `count` animation frames. */
async function frames(page: Page, count: number): Promise<void> {
  await page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
  }, count);
}

/** True when a frame shows nothing but one color (a blank canvas or a cleared one). */
function blank(image: PNG): boolean {
  const [r, g, b] = [image.data[0], image.data[1], image.data[2]];
  for (let i = 4; i < image.data.length; i += 4)
    if (image.data[i] !== r || image.data[i + 1] !== g || image.data[i + 2] !== b) return false;
  return true;
}

/** The share of pixels whose color differs by more than 32 in a channel. */
function changedFraction(a: PNG, b: PNG): number {
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4)
    for (let c = 0; c < 3; c++)
      if (Math.abs((a.data[i + c] ?? 0) - (b.data[i + c] ?? 0)) > 32) {
        changed++;
        break;
      }
  return changed / (a.width * a.height);
}

/** The settled frame of a page that starts at `deviceScaleFactor`. */
async function reference(browser: Browser, query: string, deviceScaleFactor: number): Promise<PNG> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor });
  const page = await context.newPage();
  await openVector(page, query);
  const image = await canvasImage(page);
  await context.close();
  return image;
}

for (const backend of BACKENDS) {
  test(`a pixel-ratio change from 1 to 2 and back resizes the canvas within one frame, without a blank frame, matching a page started at that ratio on ${backend} (F514)`, async ({
    page,
    browser,
  }) => {
    test.setTimeout(300_000);
    const query = `backend=${backend}&scenario=mvt-labels`;
    const expected = await reference(browser, query, 2);
    const errors = await collectErrors(page);
    await page.addInitScript(recordMediaQueries);
    await page.setViewportSize(VIEWPORT);
    await openVector(page, query);
    expect(await canvasSize(page)).toEqual({ width: 320, height: 240, cssWidth: 320, ratio: 1 });

    await setRatio(page, 2);
    // The ratio change reaches the engine as a resize; the next drawn frame has the new resolution.
    await frames(page, 2);
    expect(await canvasSize(page)).toEqual({ width: 640, height: 480, cssWidth: 320, ratio: 2 });
    // No blank frame while the tiles and labels are drawn again at the new resolution.
    for (let i = 0; i < 5; i++) expect(blank(await canvasImage(page)), `frame ${i} after the change`).toBe(false);
    await settle(page);
    const switched = await canvasImage(page);
    expect([switched.width, switched.height]).toEqual([640, 480]);
    // Text (labels) and lines drawn at the new density: the frame matches the page that started at 2x.
    expect(changedFraction(expected, switched)).toBeLessThan(0.02);

    await setRatio(page, 1);
    await frames(page, 2);
    expect(await canvasSize(page)).toEqual({ width: 320, height: 240, cssWidth: 320, ratio: 1 });
    expect(blank(await canvasImage(page))).toBe(false);
    expect(unexpected(errors)).toEqual([]);
  });
}
