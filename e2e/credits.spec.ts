// Credits (M7): the live list of the visible sources' credits with its event (F254), and the engine's own attribution
// element, which keeps required credits visible whatever the configuration or the page's CSS asks (F255).
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { openGlobe, waitForIdle } from './support/globe.ts';
import { fixtureSession, waitForImagery } from './support/imagery.ts';

interface CreditView {
  text: string;
  required: boolean;
  sources: string[];
}

async function credits(page: Page): Promise<CreditView[]> {
  return page.evaluate(() =>
    (window.vibeglobePlayground?.globe.credits() ?? []).map((c) => ({
      text: c.text,
      required: c.required,
      sources: [...c.sources],
    })),
  );
}

async function jump(page: Page, longitudeDeg: number, latitudeDeg: number): Promise<void> {
  await page.evaluate(
    ([lon, lat]) => window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: lon, latitudeDeg: lat }),
    [longitudeDeg, latitudeDeg] as const,
  );
  await waitForImagery(page);
}

test.describe('credits of the visible sources (F254)', () => {
  test.use({ viewport: { width: 320, height: 240 } });

  test('follow the sources in view, fire an event on each change, and credit a shared credit once', async ({
    page,
  }) => {
    const session = await fixtureSession(page);
    // A world layer and a translucent overlay covering only Italy, both with their own credit.
    await openGlobe(
      page,
      `backend=webgl2&imagery=smooth&overlays=patches:0.5&overlayCoverage=italy&session=${session}&lon=12.5&lat=41.9&zoom=8`,
    );
    await waitForImagery(page);
    await page.evaluate(() => {
      const events: string[][] = [];
      (window as unknown as { creditEvents: string[][] }).creditEvents = events;
      window.vibeglobePlayground?.globe.on('credits-change', ({ credits: list }) =>
        events.push(list.map((c) => c.text)),
      );
    });
    expect((await credits(page)).map((c) => c.text)).toEqual(['Fixture smooth', 'Fixture patches']);
    await jump(page, 2.35, 48.85);
    expect((await credits(page)).map((c) => c.text)).toEqual(['Fixture smooth']);
    await jump(page, 12.5, 41.9);
    expect((await credits(page)).map((c) => c.text)).toEqual(['Fixture smooth', 'Fixture patches']);
    const events = await page.evaluate(() => (window as unknown as { creditEvents: string[][] }).creditEvents);
    expect(events).toEqual([['Fixture smooth'], ['Fixture smooth', 'Fixture patches']]);
  });

  test('a credit two visible sources ask for is listed once, naming both', async ({ page }) => {
    const session = await fixtureSession(page);
    await openGlobe(
      page,
      `backend=webgl2&imagery=smooth&overlays=smooth:0.5&session=${session}&lon=12.5&lat=41.9&zoom=6`,
    );
    await waitForImagery(page);
    expect(await credits(page)).toEqual([
      { text: 'Fixture smooth', required: false, sources: ['fixture-smooth', 'overlay-smooth'] },
    ]);
  });
});

test.describe('credits of imagery and vector tiles together', () => {
  test.use({ viewport: { width: 320, height: 240 } });

  test("list a vector style source's attribution with the imagery's, while one of its layers is shown", async ({
    page,
  }) => {
    const style = JSON.parse(
      readFileSync(new URL('../apps/playground/public/vector-tiles/styles/demotiles.json', import.meta.url), 'utf8'),
    ) as { sources: Record<string, Record<string, unknown>>; layers: { id: string; source?: string }[] };
    // The style credits its vector source in HTML, as styles do ("© OpenMapTiles Data from OpenStreetMap").
    style.sources['maplibre'] = {
      ...style.sources['maplibre'],
      attribution: '<a href="https://vector.test/">&copy; Vector Example</a> data',
    };
    await page.route('https://styles.test/credited.json', (route) =>
      route.fulfill({ json: style, headers: { 'Access-Control-Allow-Origin': '*' } }),
    );
    const session = await fixtureSession(page);
    await openGlobe(
      page,
      `backend=webgl2&imagery=smooth&session=${session}&vectorStyle=https://styles.test/credited.json&lon=12.5&lat=41.9&zoom=3`,
    );
    await waitForImagery(page);
    await expect
      .poll(async () => (await credits(page)).map((c) => c.text))
      .toEqual(['Fixture smooth', '© Vector Example data']);
    // No layer of the source shown: its credit goes, the imagery's stays.
    await page.evaluate(
      (ids) => {
        const layer = (
          window as unknown as {
            vibeglobeVectorTiles?: { layer?: { style: { setVisibility(id: string, on: boolean): void } } };
          }
        ).vibeglobeVectorTiles?.layer;
        for (const id of ids) layer?.style.setVisibility(id, false);
        window.vibeglobePlayground?.globe.requestRender();
      },
      style.layers.filter((l) => l.source === 'maplibre').map((l) => l.id),
    );
    await expect.poll(async () => (await credits(page)).map((c) => c.text)).toEqual(['Fixture smooth']);
  });
});

/** The credit items of the attribution element, with whether each is the topmost element at its center. */
async function shownCredits(page: Page): Promise<{ text: string; logo: boolean; onTop: boolean; visible: boolean }[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.vg-credits .vg-credit')].map((item) => {
      const box = item.getBoundingClientRect();
      const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      const style = getComputedStyle(item.parentElement ?? item);
      return {
        text: item.textContent ?? '',
        logo: item.querySelector('img') !== null,
        onTop: top !== null && item.contains(top),
        visible:
          style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && box.width > 0,
      };
    }),
  );
}

test.describe('the engine attribution element (F255)', () => {
  for (const viewport of [
    { width: 320, height: 240 },
    { width: 800, height: 600 },
    { width: 1280, height: 720 },
  ]) {
    test(`shows every visible source's credits and the required logo, uncovered, at ${viewport.width} × ${viewport.height}`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      const session = await fixtureSession(page);
      await openGlobe(
        page,
        `backend=webgl2&imagery=smooth&overlays=patches:0.5&requiredCredit=fixture-smooth&session=${session}&lon=12.5&lat=41.9&zoom=6`,
      );
      await waitForImagery(page);
      const shown = await shownCredits(page);
      expect(shown.map((c) => c.text)).toEqual(['Required smooth', 'Fixture smooth', 'Fixture patches']);
      for (const credit of shown) expect(credit, credit.text).toMatchObject({ onTop: true, visible: true });
      expect(shown[0]?.logo).toBe(true);
    });
  }

  test('keeps a required credit when configuration, CSS or a script tries to hide it, and hides optional ones', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 800, height: 600 });
    const warnings: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'warning') warnings.push(message.text());
    });
    const session = await fixtureSession(page);
    await openGlobe(
      page,
      `backend=webgl2&imagery=smooth&overlays=patches:0.5&requiredCredit=fixture-smooth&hiddenCredits=fixture-smooth,overlay-patches&session=${session}&lon=12.5&lat=41.9&zoom=6`,
    );
    await waitForImagery(page);
    // Optional credits of hidden sources are left out; the required one stays, and a warning names its source.
    expect((await shownCredits(page)).map((c) => c.text)).toEqual(['Required smooth']);
    expect(warnings.some((w) => w.includes('fixture-smooth'))).toBe(true);
    // Page CSS and a script cannot hide the element.
    await page.addStyleTag({
      content: '.vg-credits { display: none !important; visibility: hidden !important; opacity: 0 !important; }',
    });
    await page.evaluate(() => {
      const element = document.querySelector<HTMLElement>('.vg-credits');
      if (element) element.style.display = 'none';
    });
    await waitForIdle(page);
    const shown = await shownCredits(page);
    expect(shown.map((c) => c.text)).toEqual(['Required smooth']);
    expect(shown[0]).toMatchObject({ onTop: true, visible: true });
  });
});
