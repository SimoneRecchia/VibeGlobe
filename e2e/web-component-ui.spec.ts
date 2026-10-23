// The `<vibe-globe>` element with the ui package's controls in its shadow tree, themed from the host page through CSS
// variables and the `ui` part, with the attribution visible and keyboard focus moving through the controls (F485).
import { expect, test, type Page } from '@playwright/test';
import { openExample } from './support/adapters.ts';

test.use({ viewport: { width: 1024, height: 768 } });

/** A computed style of an element inside the element's shadow tree. */
async function shadowStyle(page: Page, selector: string, property: string): Promise<string> {
  return page.evaluate(
    ([sel, prop]) => {
      const target = document.querySelector('vibe-globe')?.shadowRoot?.querySelector(sel);
      return target ? getComputedStyle(target).getPropertyValue(prop) : 'missing';
    },
    [selector, property] as const,
  );
}

test('host-page theme variables and parts restyle the controls; light and dark; attribution and focus (F485)', async ({
  page,
}) => {
  await openExample(page, 'element-ui.html');
  // Locators pierce open shadow roots.
  await expect(page.locator('vibe-globe .vg-ui__button--zoom-in')).toBeVisible();
  const background = (): Promise<string> => shadowStyle(page, '.vg-ui__control', 'background-color');
  expect(await background()).toBe('rgb(255, 255, 255)');
  // The host page's theme, through `vibe-globe::part(ui)`.
  await page.evaluate(() => document.body.classList.add('branded'));
  expect(await background()).toBe('rgb(250, 240, 230)');
  expect(await shadowStyle(page, '.vg-ui__button--zoom-in', 'color')).toBe('rgb(40, 20, 90)');
  expect(await shadowStyle(page, '.vg-ui__control', 'border-top-left-radius')).toBe('12px');
  await page.evaluate(() => document.body.classList.remove('branded'));
  // Dark and light themes through the `theme` attribute.
  await page.evaluate(() => document.querySelector('vibe-globe')?.setAttribute('theme', 'dark'));
  await expect.poll(background).toBe('rgb(31, 35, 43)');
  await page.evaluate(() => document.querySelector('vibe-globe')?.setAttribute('theme', 'light'));
  await expect.poll(background).toBe('rgb(255, 255, 255)');
  // The attribution (the engine's and the control's) is visible and not covered by any control.
  await expect(page.locator('vibe-globe .vg-ui__credit--required img')).toBeVisible();
  const covered = await page.evaluate(() => {
    const root = document.querySelector('vibe-globe')?.shadowRoot;
    if (!root) return ['no shadow root'];
    const problems: string[] = [];
    for (const item of root.querySelectorAll('.vg-credits .vg-credit, .vg-ui__credit')) {
      const box = item.getBoundingClientRect();
      const top = root.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      if (top === null || !(item === top || item.contains(top))) problems.push(item.textContent ?? '');
    }
    const credits = [...root.querySelectorAll('.vg-credits, .vg-ui__attribution')].map((e) =>
      e.getBoundingClientRect(),
    );
    for (const control of root.querySelectorAll('[data-control]:not([data-control="attribution"])')) {
      const a = control.getBoundingClientRect();
      for (const b of credits)
        if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)
          problems.push(`${(control as HTMLElement).dataset['control']} covers the attribution`);
    }
    return problems;
  });
  expect(covered).toEqual([]);
  // Keyboard focus moves through the controls inside the element.
  await page.locator('vibe-globe .vg-ui__search-input').focus();
  const order: string[] = [];
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    order.push(
      await page.evaluate(
        () => document.querySelector('vibe-globe')?.shadowRoot?.activeElement?.className.toString() ?? 'outside',
      ),
    );
  }
  expect(order.filter((name) => name.includes('vg-ui__')).length).toBeGreaterThanOrEqual(6);
  expect(new Set(order).size).toBeGreaterThanOrEqual(6);
});
