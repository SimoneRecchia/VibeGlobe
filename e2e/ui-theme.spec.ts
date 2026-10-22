// Theming, translations, keyboard access and contrast of the ui package's controls (M12, F429–F433, F435).
import { expect, test, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { expectMatchesBaseline } from './support/visual.ts';
import { openUi } from './support/ui-layer.ts';

const CONTROLS = ['search', 'zoom', 'compass', 'fullscreen', 'readout', 'debug'] as const;

/** Every control laid out and the debug panel open, with the map hidden so screenshots show only the controls. */
async function openAllControls(
  page: Page,
  options: { theme?: 'light' | 'dark'; language?: string } = {},
): Promise<void> {
  await openUi(page, { debug: true, ...options });
  await page.locator('.vg-ui__button--debug').click();
  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('#globe');
    if (canvas !== null) canvas.style.visibility = 'hidden';
    for (const id of ['status', 'cursor']) document.getElementById(id)?.style.setProperty('visibility', 'hidden');
  });
}

async function screenshots(page: Page): Promise<Map<string, Buffer>> {
  const shots = new Map<string, Buffer>();
  for (const id of CONTROLS)
    shots.set(id, await page.locator(`[data-control="${id}"]`).screenshot({ animations: 'disabled' }));
  return shots;
}

/** A computed style of the first element matching `selector`, after `prepare` (hover, focus, …). */
async function style(page: Page, selector: string, property: string): Promise<string> {
  return page
    .locator(selector)
    .first()
    .evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property);
}

/** Where each documented theme variable shows: an element, its CSS property, and how to bring it into view. */
const VARIABLE_PROBES: readonly (readonly [variable: string, selector: string, property: string, value: string])[] = [
  ['--vg-ui-font-family', '.vg-ui__search-input', 'font-family', 'Courier'],
  ['--vg-ui-font-size', '.vg-ui__readout-coordinates', 'font-size', '17px'],
  ['--vg-ui-monospace-font-family', '.vibeglobe-debug-overlay', 'font-family', 'Georgia'],
  ['--vg-ui-color', '.vg-ui__button--zoom-out', 'color', 'rgb(1, 2, 3)'],
  ['--vg-ui-muted-color', '.vg-ui__readout-detail', 'color', 'rgb(4, 5, 6)'],
  ['--vg-ui-background', '.vg-ui__control', 'background-color', 'rgb(250, 240, 230)'],
  ['--vg-ui-hover-background', '.vg-ui__button--zoom-out:hover', 'background-color', 'rgb(7, 8, 9)'],
  ['--vg-ui-border-color', '.vg-ui__control', 'border-top-color', 'rgb(10, 11, 12)'],
  ['--vg-ui-border-width', '.vg-ui__control', 'border-top-width', '3px'],
  ['--vg-ui-border-radius', '.vg-ui__control', 'border-top-left-radius', '11px'],
  ['--vg-ui-accent-color', '.vg-ui__compass-north', 'fill', 'rgb(13, 14, 15)'],
  ['--vg-ui-focus-color', '.vg-ui__button--compass:focus-visible', 'outline-color', 'rgb(16, 17, 18)'],
  ['--vg-ui-focus-width', '.vg-ui__button--compass:focus-visible', 'outline-width', '5px'],
  ['--vg-ui-button-size', '.vg-ui__button--zoom-out', 'width', '41px'],
  ['--vg-ui-icon-size', '.vg-ui__button--zoom-out svg', 'width', '23px'],
  ['--vg-ui-spacing', '.vg-ui__corner--top-right', 'padding-top', '13px'],
  ['--vg-ui-shadow', '.vg-ui__control', 'box-shadow', 'rgb(19, 20, 21) 2px 2px 0px 0px'],
  ['--vg-ui-panel-width', '.vg-ui__search', 'width', '301px'],
  ['--vg-ui-disabled-opacity', '.vg-ui__button--zoom-in:disabled', 'opacity', '0.25'],
  ['--vg-ui-transition-duration', '.vg-ui__button--zoom-out', 'transition-duration', '0.7s'],
  ['--vg-ui-debug-color', '.vibeglobe-debug-overlay', 'color', 'rgb(22, 23, 24)'],
  ['--vg-ui-debug-background', '.vibeglobe-debug-overlay', 'background-color', 'rgb(25, 26, 27)'],
  ['--vg-ui-debug-font-size', '.vibeglobe-debug-overlay', 'font-size', '15px'],
];

test('a test theme restyles every control through the documented CSS variables (F429)', async ({ page }) => {
  await openAllControls(page);
  const documented = await page.evaluate(() => Object.keys(window.vibeglobeUi?.ui.THEME_VARIABLES.light ?? {}));
  // Every documented variable is probed here, except the touch target size, which applies to coarse pointers only
  // (checked below with a touch screen).
  expect([...VARIABLE_PROBES.map(([name]) => name), '--vg-ui-touch-size'].sort()).toEqual(documented.sort());
  // Bring the probed states about: the zoom-in button disabled at the maximum zoom, a hover, a keyboard focus.
  await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ zoom: 22 }));
  const before = await screenshots(page);
  const theme = Object.fromEntries(VARIABLE_PROBES.map(([name, , , value]) => [name, value]));
  await page.evaluate((values) => {
    const layer = window.vibeglobeUi?.layer.element;
    for (const [name, value] of Object.entries(values)) layer?.style.setProperty(name, value);
  }, theme);
  for (const [variable, selector, property, value] of VARIABLE_PROBES) {
    const plain = selector.replace(/:(hover|focus-visible|disabled)$/, '');
    if (selector.endsWith(':hover')) await page.locator(plain).hover();
    if (selector.endsWith(':focus-visible')) {
      await page.locator('.vg-ui__search-input').focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      await page.locator(plain).focus();
      await page.keyboard.press('Shift');
    }
    if (selector.endsWith(':disabled')) await expect(page.locator(plain)).toBeDisabled();
    // Polled: the test theme's own transition duration animates the hover background.
    await expect.poll(() => style(page, plain, property), `${variable} → ${property} of ${plain}`).toBe(value);
  }
  await page.mouse.move(0, 0);
  const after = await screenshots(page);
  for (const id of CONTROLS) expect(after.get(id)?.equals(before.get(id) ?? Buffer.alloc(0)), id).toBe(false);
});

test.describe('touch screens', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('touch targets follow --vg-ui-touch-size, at least 44 by 44 CSS pixels by default (F429)', async ({ page }) => {
    await openUi(page);
    const box = await page.locator('.vg-ui__button--zoom-in').boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
    await page.evaluate(() => window.vibeglobeUi?.layer.element.style.setProperty('--vg-ui-touch-size', '52px'));
    expect(await style(page, '.vg-ui__button--zoom-in', 'min-height')).toBe('52px');
  });
});

test('light and dark themes switch at runtime for every control and match their baselines (F430)', async ({
  page,
}, testInfo) => {
  await openAllControls(page, { theme: 'light' });
  const colors = (): Promise<string[]> =>
    page.evaluate(
      (ids) => {
        return ids.map((id) => {
          const element = document.querySelector(`[data-control="${id}"]`);
          return element === null
            ? ''
            : `${getComputedStyle(element).backgroundColor} ${getComputedStyle(element).color}`;
        });
      },
      [...CONTROLS],
    );
  const light = await colors();
  const lightShots = await screenshots(page);
  await page.evaluate(() => window.vibeglobeUi?.layer.setTheme('dark'));
  const dark = await colors();
  const darkShots = await screenshots(page);
  const loads = await page.evaluate(() => performance.getEntriesByType('navigation').length);
  expect(loads).toBe(1);
  for (const [index, id] of CONTROLS.entries()) {
    // The debug panel keeps its own backing in both themes; its toggle button follows the theme.
    expect(dark[index], id).not.toBe(light[index]);
    for (const [theme, shots] of [
      ['light', lightShots],
      ['dark', darkShots],
    ] as const) {
      const shot = shots.get(id);
      if (shot !== undefined) await expectMatchesBaseline(page, testInfo, `ui-${id}-${theme}.png`, PNG.sync.read(shot));
    }
  }
});

/** Every text, tooltip, ARIA label and placeholder of the controls, keyed by element and attribute. */
async function uiStrings(page: Page): Promise<Map<string, string>> {
  const entries = await page.evaluate(() => {
    const result: [string, string][] = [];
    const elements = [...(window.vibeglobeUi?.layer.element.querySelectorAll('*') ?? [])];
    for (const [index, element] of elements.entries()) {
      const key = `${index}:${element.className.toString()}`;
      for (const name of ['aria-label', 'title', 'placeholder']) {
        const value = element.getAttribute(name);
        if (value) result.push([`${key}@${name}`, value]);
      }
      const own = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE);
      const text = own
        .map((node) => node.textContent ?? '')
        .join('')
        .trim();
      if (text) result.push([`${key}#text`, text]);
    }
    const layer = window.vibeglobeUi?.layer.element.getAttribute('aria-label');
    if (layer) result.push(['layer@aria-label', layer]);
    return result;
  });
  return new Map(entries);
}

test('English and Italian switch at runtime for every string and number format (F431)', async ({ page }) => {
  await openAllControls(page);
  // A status message and the readout's text are part of the strings too.
  await page.locator('.vg-ui__search-input').fill('Roma');
  const english = await uiStrings(page);
  await page.evaluate(() => window.vibeglobeUi?.layer.setLanguage('it'));
  const italian = await uiStrings(page);
  expect([...italian.keys()].sort()).toEqual([...english.keys()].sort());
  // Figures that are not words (the debug panel's metrics, coordinates in degrees) stay; every word changes.
  const unchanged = [...english].filter(([key, value]) => italian.get(key) === value && /[a-z]{3}/i.test(value));
  expect(unchanged.filter(([key]) => !key.includes('debug-overlay') && !key.includes('vibeglobe'))).toEqual([]);
  await expect(page.locator('.vg-ui__readout-coordinates')).toHaveText(/^\d+,\d{5}°[NS] \d+,\d{5}°[EW]$/);
  await page.locator('.vg-ui__search-input').fill('45,5 9,25');
  await expect(page.locator('.vg-ui__search-option')).toHaveText('Vai a 45,50000°N 9,25000°E');
  expect(await page.locator('.vg-ui').getAttribute('lang')).toBe('it');
});

test('an application registers a language and overrides one string without changing the package (F432)', async ({
  page,
}) => {
  await openAllControls(page);
  const english = await uiStrings(page);
  await page.evaluate(() => {
    const i18n = window.vibeglobeUi?.layer.i18n;
    i18n?.registerLanguage('xx', {
      'controls.label': 'XX map controls',
      'zoom.in': 'XX in',
      'zoom.out': 'XX out',
      'compass.title': 'XX north',
      'fullscreen.label': 'XX full',
      'debug.label': 'XX debug',
      'search.label': 'XX search',
      'search.placeholder': 'XX type here',
      'readout.label': 'XX coordinates',
    });
    i18n?.setLanguage('xx');
  });
  await expect(page.locator('.vg-ui__button--zoom-in')).toHaveAttribute('aria-label', 'XX in');
  await expect(page.locator('.vg-ui__search-input')).toHaveAttribute('placeholder', 'XX type here');
  await expect(page.locator('.vg-ui__button--debug')).toHaveAttribute('aria-label', 'XX debug');
  // Keys the language leaves out fall back to English.
  await expect(page.locator('.vg-ui__button--readout-format')).toHaveAttribute(
    'aria-label',
    'Coordinate format: decimal degrees. Press to change.',
  );
  await page.evaluate(() => {
    const i18n = window.vibeglobeUi?.layer.i18n;
    i18n?.setLanguage('en');
    i18n?.overrideStrings('en', { 'zoom.out': 'Smaller' });
  });
  const overridden = await uiStrings(page);
  const changed = [...english].filter(([key, value]) => overridden.get(key) !== value).map(([key]) => key);
  expect(changed).toHaveLength(2);
  expect(changed.every((key) => key.includes('zoom-out'))).toBe(true);
  await expect(page.locator('.vg-ui__button--zoom-out')).toHaveAttribute('aria-label', 'Smaller');
});

test.describe('keyboard', () => {
  for (const theme of ['light', 'dark'] as const) {
    test(`tabs through every control in order with a visible focus indicator, ${theme} theme (F433)`, async ({
      page,
    }) => {
      await openUi(page, { debug: true, theme });
      await page.locator('#globe').focus();
      const order: string[] = [];
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press('Tab');
        const focused = await page.evaluate(() => {
          const element = document.activeElement;
          if (element === null || element === document.body) return { name: 'body' };
          const inUi = element.closest('.vg-ui') !== null;
          const name = element.className.toString().replace(/.*vg-ui__(button--)?/, '') || element.id;
          if (!inUi) return { name };
          const style = getComputedStyle(element);
          const layer = getComputedStyle(element.closest('.vg-ui') ?? element);
          return {
            name,
            outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
            expected: layer.getPropertyValue('--vg-ui-focus-width').trim(),
          };
        });
        order.push(focused.name);
        if ('outline' in focused)
          expect(focused.outline, focused.name).toMatch(new RegExp(`^solid ${focused.expected} rgb`));
        if (focused.name === 'body' || focused.name === 'globe') break;
      }
      // Corners in reading order: search (top left); zoom, compass, fullscreen (top right); readout and debug (bottom
      // left). Focus then leaves the controls: no trap.
      expect(order.slice(0, 7)).toEqual([
        'search-input',
        'zoom-in',
        'zoom-out',
        'compass',
        'fullscreen',
        'readout-format',
        'debug',
      ]);
      expect(order.length).toBeLessThanOrEqual(9);
    });
  }

  test("switches the readout's format with Enter and Space (F433)", async ({ page }) => {
    await openUi(page);
    const format = page.locator('.vg-ui__button--readout-format');
    await format.focus();
    await page.keyboard.press('Enter');
    await expect(format).toHaveAttribute('aria-label', /degrees, minutes, seconds/);
    await page.keyboard.press('Space');
    await expect(format).toHaveAttribute('aria-label', /UTM/);
    await expect(page.locator('.vg-ui__readout-coordinates')).toHaveText(/^\d{1,2}[C-X] \d+ \d+$/);
  });

  test('operates the search box with arrows, Enter and Escape (F433)', async ({ page }) => {
    await openUi(page, {
      // A geocoder with two results, so the arrow keys have something to move through.
      defaults: false,
    });
    await page.evaluate(() => {
      const handle = window.vibeglobeUi;
      if (handle === undefined) throw new Error('no ui');
      handle.layer.add(
        new handle.ui.SearchControl({
          debounceMs: 0,
          geocoder: {
            search: () =>
              Promise.resolve([
                { label: 'Alpha', longitudeDeg: 10, latitudeDeg: 10 },
                { label: 'Beta', longitudeDeg: 20, latitudeDeg: 20 },
              ]),
          },
        }),
      );
    });
    const input = page.locator('.vg-ui__search-input');
    await input.focus();
    await page.keyboard.type('somewhere');
    await expect(page.locator('.vg-ui__search-option')).toHaveCount(2);
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.vg-ui__search-option[aria-selected="true"]')).toHaveText('Beta');
    await expect(input).toHaveAttribute('aria-activedescendant', /option-1$/);
    await page.keyboard.press('Enter');
    await expect
      .poll(() => page.evaluate(() => window.vibeglobePlayground?.globe.camera.longitudeDeg))
      .toBeCloseTo(20, 6);
    await page.keyboard.type('again');
    await expect(page.locator('.vg-ui__search-option')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(input).toHaveValue('');
    await expect(page.locator('.vg-ui__search-option')).toHaveCount(0);
  });
});

test('every control meets WCAG 2.1 AA contrast in both themes, backed against any imagery (F435)', async ({ page }) => {
  for (const theme of ['light', 'dark'] as const) {
    await openAllControls(page, { theme });
    await page.locator('.vg-ui__search-input').fill('Rome');
    const failures = await page.evaluate(() => {
      const parse = (color: string): [number, number, number, number] => {
        const [r = 0, g = 0, b = 0, a = 1] = (color.match(/[\d.]+/g) ?? []).map(Number);
        return [r, g, b, a];
      };
      const luminance = ([r, g, b]: number[]): number => {
        const [lr = 0, lg = 0, lb = 0] = [r, g, b].map((c) => {
          const v = (c ?? 0) / 255;
          return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
      };
      const ratio = (a: number[], b: number[]): number => {
        const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
        return (x + 0.05) / (y + 0.05);
      };
      /** The opaque background a pixel of `element` sits on, from the element outwards. */
      const backdrop = (element: Element): number[] | undefined => {
        for (let node: Element | null = element; node !== null; node = node.parentElement) {
          const [r, g, b, a] = parse(getComputedStyle(node).backgroundColor);
          if (a === 1) return [r, g, b];
          if (a > 0) return undefined;
          if (node.classList.contains('vg-ui')) return undefined;
        }
        return undefined;
      };
      const problems: string[] = [];
      const layer = window.vibeglobeUi?.layer.element;
      if (layer === undefined) return ['no ui'];
      // Every control has an opaque backing shape, so icons and text never sit on the imagery itself.
      for (const control of layer.querySelectorAll('[data-control]'))
        if (backdrop(control) === undefined)
          problems.push(`${control.getAttribute('data-control')}: no opaque backing`);
      // Text (4.5:1) and icons (3:1, non-text contrast); the debug panel's backing is checked in styles.test.ts.
      for (const element of layer.querySelectorAll('*')) {
        if (element.closest('.vibeglobe-debug-overlay') !== null) continue;
        const style = getComputedStyle(element);
        const isIcon = element instanceof SVGPathElement;
        const hasText = [...element.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
        const isInput = element instanceof HTMLInputElement;
        if (!isIcon && !hasText && !isInput) continue;
        if (element.closest('button:disabled') !== null) continue;
        const back = backdrop(element);
        const fore = parse(isIcon ? style.fill : style.color);
        const minimum = isIcon ? 3 : 4.5;
        if (back === undefined || ratio(fore, back) < minimum)
          problems.push(
            `${element.className.toString()}: ${back === undefined ? 'no backdrop' : ratio(fore, back).toFixed(2)}`,
          );
      }
      // The focus indicator against the control's backing (3:1).
      const focus = parse(
        getComputedStyle(layer)
          .getPropertyValue('--vg-ui-focus-color')
          .trim()
          .replace(
            /^#(..)(..)(..)$/,
            (_m, r: string, g: string, b: string) => `rgb(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)})`,
          ),
      );
      const backing = parse(getComputedStyle(layer.querySelector('.vg-ui__control') ?? layer).backgroundColor);
      if (ratio(focus, backing) < 3) problems.push(`focus: ${ratio(focus, backing).toFixed(2)}`);
      return problems;
    });
    expect(failures, theme).toEqual([]);
  }
});
