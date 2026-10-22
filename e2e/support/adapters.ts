// Helpers for the framework adapters' end-to-end tests (M14): the example pages of apps/adapter-examples and the Nuxt
// example, driven through their test hooks (`window.adapterExample`, apps/adapter-examples/src/hooks.ts).
import { expect, type Page } from '@playwright/test';
import type { Globe } from '@vibeglobe/core';

/** The adapter examples' dev server (apps/adapter-examples). */
const EXAMPLES_URL = `http://localhost:${process.env['ADAPTER_EXAMPLES_PORT'] ?? 5180}`;
/** The Nuxt example's production server (apps/nuxt-example). */
export const NUXT_URL = `http://localhost:${process.env['NUXT_EXAMPLE_PORT'] ?? 5181}`;

/** An event the example recorded. */
export interface RecordedEvent {
  readonly source: string;
  readonly type: string;
  readonly payload: unknown;
}

declare global {
  interface Window {
    adapterExample?: {
      readonly events: RecordedEvent[];
      globes(): (Globe | undefined)[];
      show(shown: boolean, index?: number): Promise<void>;
      setView(view: { longitudeDeg?: number; latitudeDeg?: number; zoom?: number }): Promise<void>;
      displayed?(): Record<string, number | boolean>;
    };
  }
}

/** Collects console errors and warnings of a page, for tests that assert there are none. */
export function consoleProblems(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (message) => {
    // The software GPU's driver reports its own performance notes as warnings; they are not the page's.
    if (/GL Driver Message \(OpenGL, Performance/.test(message.text())) return;
    if (message.type() === 'error' || message.type() === 'warning')
      problems.push(`${message.type()}: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  return problems;
}

/** Opens an example page and waits until each of its globes drew its first frame. */
export async function openExample(page: Page, path: string, globes = 1): Promise<void> {
  await page.goto(path.startsWith('http') ? path : `${EXAMPLES_URL}/${path}`);
  await page.waitForFunction((count) => {
    const all = window.adapterExample?.globes() ?? [];
    return all.length === count && all.every((globe) => globe !== undefined);
  }, globes);
  await page.evaluate(async () => {
    await Promise.all((window.adapterExample?.globes() ?? []).map((globe) => globe?.ready));
  });
}

/** The events of one type the example recorded. */
export async function eventsOf(page: Page, type: string, source?: string): Promise<RecordedEvent[]> {
  return page.evaluate(
    ({ type, source }) =>
      (window.adapterExample?.events ?? []).filter(
        (event) => event.type === type && (source === undefined || event.source === source),
      ),
    { type, source },
  );
}

/** Waits until the example recorded an event of the type. */
export async function waitForEvent(page: Page, type: string, source?: string): Promise<RecordedEvent> {
  await expect.poll(async () => (await eventsOf(page, type, source)).length, { timeout: 30_000 }).toBeGreaterThan(0);
  const [first] = await eventsOf(page, type, source);
  if (!first) throw new Error(`no ${type} event`);
  return first;
}

/**
 * The share of a globe's frame, read back by the engine, that the globe covers (opaque pixels), and how many distinct
 * colors it shows: a rendered globe covers a good part of its frame with imagery, not one flat color.
 */
async function frameCoverage(page: Page, index = 0): Promise<{ covered: number; colors: number }> {
  return page.evaluate(async (i) => {
    const capture = await window.adapterExample?.globes()[i]?.captureFrame();
    if (!capture) throw new Error(`no globe ${i}`);
    let opaque = 0;
    const colors = new Set<number>();
    for (let p = 0; p < capture.rgba.length; p += 4) {
      if ((capture.rgba[p + 3] ?? 0) < 255) continue;
      opaque++;
      colors.add(
        ((capture.rgba[p] ?? 0) >> 4) * 256 +
          ((capture.rgba[p + 1] ?? 0) >> 4) * 16 +
          ((capture.rgba[p + 2] ?? 0) >> 4),
      );
    }
    return { covered: opaque / (capture.rgba.length / 4), colors: colors.size };
  }, index);
}

/** Asserts that a globe of the page shows the Earth. */
export async function expectRenderedGlobe(page: Page, index = 0): Promise<void> {
  const { covered, colors } = await frameCoverage(page, index);
  expect(covered).toBeGreaterThan(0.2);
  expect(colors).toBeGreaterThan(20);
}

/** The camera of a globe of the page. */
export async function cameraOf(
  page: Page,
  index = 0,
): Promise<{ longitudeDeg: number; latitudeDeg: number; zoom: number }> {
  return page.evaluate((i) => {
    const camera = window.adapterExample?.globes()[i]?.camera;
    if (!camera) throw new Error(`no globe ${i}`);
    return { longitudeDeg: camera.longitudeDeg, latitudeDeg: camera.latitudeDeg, zoom: camera.zoom };
  }, index);
}

/** Drags with the mouse from a point by an offset, in small steps, and waits for the engine's next frame. */
export async function drag(page: Page, xPx: number, yPx: number, dxPx: number, dyPx: number): Promise<void> {
  await page.mouse.move(xPx, yPx);
  await page.mouse.down();
  await page.mouse.move(xPx + dxPx, yPx + dyPx, { steps: 8 });
  await page.mouse.up();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
