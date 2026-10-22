import { describe, expect, it } from 'vitest';
import { RULES_CSS, THEME_CSS, THEME_VARIABLES, type ThemeVariable } from './styles.js';

/** WCAG 2.1 relative luminance of an sRGB hex color. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r = 0, g = 0, b = 0] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

describe('theme stylesheet (F429)', () => {
  it('uses no hard-coded color, font or size outside the variable defaults', () => {
    // Every declaration value of the rules, with the variable references removed.
    const values = [...RULES_CSS.matchAll(/[\w-]+\s*:\s*([^;{}]+)/g)].map((match) => match[1] ?? '');
    const literals = values.map((value) => value.replace(/var\(--vg-ui-[\w-]+\)/g, '')).join(' ');
    expect(literals).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    expect(literals).not.toMatch(/\d(px|em|rem|pt|vh|vw|ms|s)\b/);
    expect(literals).not.toMatch(/\b(serif|sans-serif|monospace|system-ui|white|black|red|blue|gray|grey)\b/i);
  });

  it('defines every variable in both themes, and nothing else in the theme blocks', () => {
    const names = Object.keys(THEME_VARIABLES.light).sort();
    expect(Object.keys(THEME_VARIABLES.dark).sort()).toEqual(names);
    const used = new Set([...RULES_CSS.matchAll(/var\((--vg-ui-[\w-]+)\)/g)].map((match) => match[1]));
    for (const name of used) expect(names).toContain(name);
    expect(THEME_CSS.replace(/--vg-ui-[\w-]+:[^;]+;/g, '')).not.toMatch(/[a-z-]+\s*:\s*[^;{}]*\d/);
  });
});

describe('contrast of both themes (F435)', () => {
  const pairs: readonly (readonly [ThemeVariable, ThemeVariable, number])[] = [
    // Text: 4.5:1 (WCAG 2.1 SC 1.4.3); icons, borders and the focus indicator: 3:1 (SC 1.4.11).
    ['--vg-ui-color', '--vg-ui-background', 4.5],
    ['--vg-ui-color', '--vg-ui-hover-background', 4.5],
    ['--vg-ui-muted-color', '--vg-ui-background', 4.5],
    ['--vg-ui-muted-color', '--vg-ui-hover-background', 4.5],
    ['--vg-ui-accent-color', '--vg-ui-background', 3],
    ['--vg-ui-border-color', '--vg-ui-background', 3],
    ['--vg-ui-focus-color', '--vg-ui-background', 3],
    ['--vg-ui-focus-color', '--vg-ui-hover-background', 3],
  ];
  it.each(['light', 'dark'] as const)('the %s theme meets WCAG 2.1 AA', (theme) => {
    const values = THEME_VARIABLES[theme];
    for (const [foreground, background, minimum] of pairs) {
      expect(contrast(values[foreground], values[background]), `${foreground} on ${background}`).toBeGreaterThanOrEqual(
        minimum,
      );
    }
  });

  it('keeps the debug panel readable over any imagery', () => {
    // White text over a 75% black backing: at worst over white imagery the backing is #404040.
    expect(contrast('#ffffff', '#404040')).toBeGreaterThanOrEqual(4.5);
    expect(THEME_VARIABLES.light['--vg-ui-debug-background']).toBe('rgba(0, 0, 0, 0.75)');
  });
});
