// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { themeValue } from './value.js';

describe('theme values of what controls draw on the map (F429, KB-166)', () => {
  it('reads a variable set on the UI layer, and falls back to the light default', () => {
    const container = document.createElement('div');
    expect(themeValue(container, '--vg-ui-drawing-color')).toBe('#d93025');
    const layer = document.createElement('div');
    layer.className = 'vg-ui';
    layer.style.setProperty('--vg-ui-drawing-color', 'rgb(0, 128, 0)');
    container.append(layer);
    document.body.append(container);
    expect(themeValue(container, '--vg-ui-drawing-color')).toBe('rgb(0, 128, 0)');
    expect(themeValue(container, '--vg-ui-marker-color')).toBe('#1a73e8');
    container.remove();
  });
});
