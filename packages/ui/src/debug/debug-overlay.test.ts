// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { createDebugOverlay } from './debug-overlay.js';

describe('createDebugOverlay', () => {
  it('shows dashes until values arrive, then the formatted values', () => {
    const container = document.createElement('div');
    const overlay = createDebugOverlay(container);
    const text = (metric: string): string | null | undefined =>
      container.querySelector(`[data-metric="${metric}"]`)?.textContent;

    expect(text('frame-time')).toBe('frame – ms');
    expect(text('frame-rate')).toBe('rate  – fps');

    overlay.update({ frameTimeMs: 16.6667, framesPerSecond: 60 });
    expect(text('frame-time')).toBe('frame 16.7 ms');
    expect(text('frame-rate')).toBe('rate  60.0 fps');
  });

  it('is announced as a status region and removed on destroy', () => {
    const container = document.createElement('div');
    const overlay = createDebugOverlay(container);
    expect(container.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe('Engine diagnostics');
    overlay.destroy();
    expect(container.children).toHaveLength(0);
  });

  it('shows info rows keyed by metric and replaces them on the next call', () => {
    const container = document.createElement('div');
    const overlay = createDebugOverlay(container);
    overlay.setInfo([
      ['backend', 'backend webgpu'],
      ['max-texture-size', 'max texture 8192'],
    ]);
    expect(container.querySelector('[data-metric="backend"]')?.textContent).toBe('backend webgpu');
    overlay.setInfo([['backend', 'backend webgl2']]);
    expect(container.querySelectorAll('[data-metric]').length).toBe(3);
    expect(container.querySelector('[data-metric="backend"]')?.textContent).toBe('backend webgl2');
  });
});
