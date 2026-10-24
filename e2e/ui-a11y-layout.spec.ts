// Accessibility, reduced motion and layout of every ui control at once (M12, F434, F436, F437).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { waitForIdle } from './support/globe.ts';
import { fixtureSession } from './support/imagery.ts';
import { openUi } from './support/ui-layer.ts';

/** The IBM Equal Access engine (Apache-2.0, ADR 0101), injected into the page. */
const ACE = readFileSync(createRequire(import.meta.url).resolve('accessibility-checker-engine/ace.js'), 'utf8');

/** Opens the playground with every control: the navigation set, the tools and the minimap, with credits to show. */
async function openEverything(
  page: Page,
  options: { theme?: 'light' | 'dark'; language?: string } = {},
): Promise<void> {
  const session = await fixtureSession(page);
  await openUi(page, {
    query: `backend=webgl2&lon=7.66&lat=45.07&zoom=6&requiredCredit=fixture-smooth&imagery=smooth&session=${session}`,
    defaults: 'all',
    debug: true,
    ...options,
  });
  await page.evaluate(() => {
    const handle = window.vibeglobeUi;
    if (handle === undefined) throw new Error('no ui');
    const { ui, minimap, layer } = handle;
    layer.add(new ui.DrawControl());
    layer.add(new ui.MeasureControl());
    layer.add(new ui.BookmarksControl());
    layer.add(new ui.ScreenshotControl());
    layer.add(new minimap.MinimapControl({ imageUrl: '/imagery/natural-earth-4096.jpg' }));
  });
  await waitForIdle(page);
}

interface AuditResult {
  readonly rule: string;
  readonly path: string;
  readonly message: string;
}

/** Runs the WCAG 2.1 (A and AA) rule set on the UI layer and returns its violations. */
async function audit(page: Page): Promise<AuditResult[]> {
  await page.addScriptTag({ content: ACE });
  return page.evaluate(async () => {
    const { ace } = window as unknown as {
      ace: {
        Checker: new () => {
          check(
            node: Element,
            rulesets: string[],
          ): Promise<{ results: { ruleId: string; value: string[]; path: { dom: string }; message: string }[] }>;
        };
      };
    };
    const layer = document.querySelector('.vg-ui');
    if (layer === null) throw new Error('no ui');
    const report = await new ace.Checker().check(layer, ['WCAG_2_1']);
    return report.results
      .filter((result) => result.value[0] === 'VIOLATION' && result.value[1] === 'FAIL')
      .map((result) => ({ rule: result.ruleId, path: result.path.dom, message: result.message }));
  });
}

test.describe('accessibility audit (F434)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  for (const theme of ['light', 'dark'] as const)
    for (const language of ['en', 'it'] as const)
      test(`every control passes WCAG 2.1 A and AA with zero violations, ${theme} theme, ${language}`, async ({
        page,
      }) => {
        await openEverything(page, { theme, language });
        // Open the panels too, so their contents are audited.
        await page.locator('.vg-ui__button--layers').click();
        await page.locator('.vg-ui__button--bookmarks').click();
        await page.locator('.vg-ui__button--draw-line').first().click();
        expect(await audit(page)).toEqual([]);
      });

  test('state changes update the ARIA states', async ({ page }) => {
    await openEverything(page);
    await page.locator('.vg-ui__button--view-2d').click();
    await expect(page.locator('.vg-ui__button--view-2d')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.vg-ui__button--view-auto')).toHaveAttribute('aria-pressed', 'false');
    const fullscreen = page.locator('.vg-ui__button--fullscreen');
    await fullscreen.click();
    await expect(fullscreen).toHaveAttribute('aria-pressed', 'true');
    await fullscreen.click();
    await expect(fullscreen).toHaveAttribute('aria-pressed', 'false');
    const layers = page.locator('.vg-ui__button--layers');
    await layers.click();
    await expect(layers).toHaveAttribute('aria-expanded', 'true');
    const smooth = page.locator('.vg-ui__layers-panel input[value="fixture-smooth"]');
    await expect(smooth).toBeChecked();
    await page.locator('.vg-ui__button--draw-point').click();
    await expect(page.locator('.vg-ui__button--draw-point')).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('reduced motion (F436)', () => {
  test.use({ viewport: { width: 800, height: 600 } });

  /** The zoom values of the frames drawn while an action runs, until the engine goes idle. */
  async function framesOf(page: Page, action: () => Promise<void>): Promise<number[]> {
    await page.evaluate(() => {
      const globe = window.vibeglobePlayground?.globe;
      const zooms: number[] = [];
      (window as unknown as { zooms: number[] }).zooms = zooms;
      globe?.on('frame', () => zooms.push(globe.camera.zoom));
    });
    await action();
    await waitForIdle(page);
    return page.evaluate(() => (window as unknown as { zooms: number[] }).zooms);
  }

  test('removes UI animations and turns flights into quick fades, and returns to normal when off', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openEverything(page);
    const transition = (): Promise<string> =>
      page.locator('.vg-ui__button--zoom-in').evaluate((element) => getComputedStyle(element).transitionDuration);
    expect(await transition()).toBe('0s');
    // A zoom step lands in one frame: no intermediate value.
    const start = await page.evaluate(() => window.vibeglobePlayground?.globe.camera.zoom ?? NaN);
    const zooms = await framesOf(page, () => page.locator('.vg-ui__button--zoom-in').click());
    expect(zooms.filter((z) => z > start + 1e-6 && z < start + 1 - 1e-6)).toEqual([]);
    // A flight (reset to globe) is a quick fade: the engine reports reduced motion and it ends within 400 ms.
    expect(await page.evaluate(() => window.vibeglobePlayground?.globe.reducedMotion)).toBe(true);
    const fade = await page.evaluate(async () => {
      const globe = window.vibeglobePlayground?.globe;
      if (globe === undefined) throw new Error('no globe');
      const started = globe.timeMs;
      (document.querySelector('.vg-ui__button--reset-globe') as HTMLButtonElement).click();
      await new Promise<void>((resolve) => {
        const stop = globe.on('moveend', () => {
          stop();
          resolve();
        });
      });
      return globe.timeMs - started;
    });
    expect(fade).toBeLessThanOrEqual(400);
    // The tilt slider sets the tilt at once.
    // The slider only needs the zoom applied, not the zoom-10 tiles loaded (waiting for them overran the timeout).
    await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ zoom: 10 }));
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.locator('.vg-ui__tilt-track').focus();
    await page.keyboard.press('End');
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await page.evaluate(() => window.vibeglobePlayground?.globe.camera.chosenTiltDeg)).toBeCloseTo(85, 6);

    // Back to normal: transitions and animated steps return (back at the first view, whose tiles are loaded).
    await page.evaluate((zoom) => window.vibeglobePlayground?.globe.jumpTo({ zoom, tiltDeg: 0 }), start + 1);
    await waitForIdle(page);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    expect(await transition()).toBe('0.15s');
    const before = await page.evaluate(() => window.vibeglobePlayground?.globe.camera.zoom ?? NaN);
    const animated = await framesOf(page, () => page.locator('.vg-ui__button--zoom-out').click());
    expect(animated.filter((z) => z < before - 1e-6 && z > before - 1 + 1e-6).length).toBeGreaterThanOrEqual(2);
    expect(await page.evaluate(() => window.vibeglobePlayground?.globe.reducedMotion)).toBe(false);
  });
});

/** Boxes of every control and of the attributions. */
async function boxes(page: Page): Promise<{ controls: { id: string; box: DOMRect }[]; credits: DOMRect[] }> {
  return page.evaluate(() => {
    const visible = (element: Element): boolean => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    const controls = [...document.querySelectorAll('.vg-ui [data-control]')].filter(visible).map((element) => ({
      id: (element as HTMLElement).dataset['control'] ?? '',
      box: element.getBoundingClientRect().toJSON() as DOMRect,
    }));
    const credits = [...document.querySelectorAll('.vg-credits, .vg-ui__attribution')]
      .filter(visible)
      .map((element) => element.getBoundingClientRect().toJSON() as DOMRect);
    return { controls, credits };
  });
}

const overlap = (a: DOMRect, b: DOMRect): boolean =>
  a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

/** Whether every credit item and logo is the topmost element at its center and inside the viewport. */
async function creditsUncovered(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    for (const item of document.querySelectorAll(
      '.vg-credits .vg-credit, .vg-credits img, .vg-ui__credit--required, .vg-ui__credit--required img',
    )) {
      const box = item.getBoundingClientRect();
      if (box.width === 0) continue;
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const inside = box.left >= 0 && box.top >= 0 && box.right <= innerWidth + 0.5 && box.bottom <= innerHeight + 0.5;
      const top = document.elementFromPoint(x, y);
      if (!inside || top === null || !(item === top || item.contains(top) || top.contains(item)))
        problems.push(`${item.className || item.tagName} covered by ${top?.className.toString() ?? 'nothing'}`);
    }
    return problems;
  });
}

test.describe('layout (F437)', () => {
  test.use({ hasTouch: true, isMobile: true });

  for (const [name, width, height] of [
    ['desktop landscape', 1280, 800],
    ['desktop portrait', 800, 1280],
    ['tablet landscape', 1024, 768],
    ['tablet portrait', 768, 1024],
  ] as const)
    test(`no control overlaps another or the attribution, touch targets ≥ 44 px: ${name}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await openEverything(page);
      const { controls, credits } = await boxes(page);
      expect(controls.length).toBeGreaterThanOrEqual(18);
      const overlaps: string[] = [];
      for (const [i, a] of controls.entries()) {
        for (const b of controls.slice(i + 1)) if (overlap(a.box, b.box)) overlaps.push(`${a.id} × ${b.id}`);
        for (const credit of credits)
          if (a.id !== 'attribution' && overlap(a.box, credit)) overlaps.push(`${a.id} × attribution`);
      }
      expect(overlaps).toEqual([]);
      expect(await creditsUncovered(page)).toEqual([]);
      const small = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.vg-ui button, .vg-ui input, .vg-ui a, .vg-ui [role="slider"]')]
          .filter((element) => element.getBoundingClientRect().width > 0)
          .map((element) => ({ name: element.className, box: element.getBoundingClientRect() }))
          .filter(({ box }) => box.width < 44 - 0.01 || box.height < 44 - 0.01)
          .map(({ name, box }) => `${name} ${box.width}x${box.height}`),
      );
      expect(small).toEqual([]);
    });

  for (const [name, width, height] of [
    ['phone portrait', 375, 667],
    ['phone landscape', 667, 375],
  ] as const)
    test(`the attribution and required logos stay visible and uncovered: ${name}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await openEverything(page);
      await expect(page.locator('.vg-ui__credit--required img')).toBeVisible();
      expect(await creditsUncovered(page)).toEqual([]);
    });
});
