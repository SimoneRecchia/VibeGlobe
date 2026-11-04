// A provider's required logo and credit, declared by the application's own profile, stay visible and uncovered (F255,
// F679).
import { expect, test, type Page } from '@playwright/test';
import { mountSource, openSources, tilePng } from './support/sources.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST',
};

/** A 1 × 1 PNG standing in for the application's copy of a provider's logo. */
const LOGO =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==';

/** Each credit item and its logo: fully inside the viewport, visible, and the topmost element at its corners. */
async function credits(page: Page) {
  return page.evaluate(() => {
    const unobstructed = (element: Element): boolean => {
      const box = element.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return false;
      if (box.left < 0 || box.top < 0 || box.right > innerWidth || box.bottom > innerHeight) return false;
      const inset = 1;
      return [
        [box.left + inset, box.top + inset],
        [box.right - inset, box.top + inset],
        [box.left + inset, box.bottom - inset],
        [box.right - inset, box.bottom - inset],
        [box.left + box.width / 2, box.top + box.height / 2],
      ].every(([x, y]) => {
        const top = document.elementFromPoint(x ?? 0, y ?? 0);
        return top !== null && (element === top || element.contains(top));
      });
    };
    const visible = (element: Element): boolean => {
      for (let e: Element | null = element; e; e = e.parentElement) {
        const style = getComputedStyle(e);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 1) return false;
      }
      return true;
    };
    return [...document.querySelectorAll('.vg-credits .vg-credit')].map((item) => {
      const logo = item.querySelector('img');
      return {
        text: item.textContent?.trim() ?? '',
        shown: visible(item) && unobstructed(item),
        logo: logo === null ? 'none' : visible(logo) && unobstructed(logo) ? 'shown' : 'covered',
      };
    });
  });
}

/** Adds the UI package's layer with every default control over the mounted globe. */
async function addEveryControl(page: Page): Promise<void> {
  await page.evaluate(async (entry) => {
    const ui = (await import(/* @vite-ignore */ entry)) as typeof import('@vibeglobe/ui');
    const globe = window.vibeglobeSources?.globe;
    const container = document.querySelector<HTMLElement>('.vg-source-test');
    if (!globe || !container) throw new Error('no mounted globe');
    ui.addDefaultControls(ui.createUi(globe, container), { debug: true });
  }, `/@fs${process.cwd()}/packages/ui/src/index.ts`);
}

test.describe("a provider's required logo and credit (F255, F679)", () => {
  test.setTimeout(240_000);
  const sizes = [
    { name: 'desktop', width: 1280, height: 800 },
    { name: 'tablet', width: 1024, height: 768 },
    { name: 'phone', width: 390, height: 844 },
  ];
  // The application's own provider: its tiles from a stand-in host, its logo and credit required by its profile.
  const mountProvider = async (page: Page, hiddenCredits?: readonly string[]) => {
    await page.route('https://tiles.provider.test/**', (route) => {
      const [z = 0, x = 0, y = 0] =
        /\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(route.request().url())?.slice(1).map(Number) ?? [];
      return route.fulfill({
        status: 200,
        contentType: 'image/png',
        headers: CORS,
        body: Buffer.from(tilePng(z, x, y)),
      });
    });
    await openSources(page, 'lon=12.5&lat=41.9&zoom=4');
    await mountSource(
      page,
      `(s, logo) => {
        const credit = { text: 'Provider', logo: { src: logo, alt: 'Provider' } };
        return s.xyzImagery({
          id: 'provider',
          url: 'https://tiles.provider.test/{z}/{x}/{y}.png',
          attribution: [credit],
          profile: { id: 'provider', requiredAttribution: credit, displayOnly: true },
        });
      }`,
      LOGO,
      hiddenCredits ? { hiddenCredits } : {},
    );
    await addEveryControl(page);
  };

  for (const size of sizes)
    for (const orientation of ['landscape', 'portrait'] as const) {
      const [width, height] =
        (orientation === 'landscape') === size.width > size.height
          ? [size.width, size.height]
          : [size.height, size.width];
      test(`stay visible and uncovered with every control, ${size.name} ${orientation} (${width} × ${height})`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height });
        await mountProvider(page);
        await expect.poll(() => credits(page)).toContainEqual({ text: 'Provider', shown: true, logo: 'shown' });
        for (const credit of await credits(page)) expect(credit, credit.text).toMatchObject({ shown: true });
      });
    }

  test('stay visible when configuration or the page CSS tries to hide or cover them', async ({ page }) => {
    // The regression test of TB-02 (docs/internal/known-bugs.md): the logo inside the credits element stays pinned.
    await page.setViewportSize({ width: 800, height: 600 });
    await mountProvider(page, ['provider']);
    await expect.poll(() => credits(page)).toContainEqual({ text: 'Provider', shown: true, logo: 'shown' });
    await page.addStyleTag({
      content:
        '.vg-credits, .vg-credit img { display: none !important; visibility: hidden !important; opacity: 0 !important; }' +
        '.vg-ui * { z-index: 2147483647 !important; }',
    });
    await page.evaluate(() => window.vibeglobeSources?.globe?.requestRender());
    await expect
      .poll(() => credits(page), { message: 'after the page CSS' })
      .toContainEqual({ text: 'Provider', shown: true, logo: 'shown' });
    // The profile declares display-only use: reading the drawn pixels back is refused.
    const refusal = await page.evaluate(() =>
      window.vibeglobeSources?.globe?.captureView({ widthPx: 64, heightPx: 64 }).then(
        () => 'captured',
        (error: unknown) => (error as { code?: string }).code,
      ),
    );
    expect(refusal).toBe('display-only');
  });
});
