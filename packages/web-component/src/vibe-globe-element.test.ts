// @vitest-environment happy-dom
// F482, F483: explicit registration under a configurable tag name; properties mirror the attributes.
import type { Globe, GlobeOptions } from '@vibeglobe/core';
import { describe, expect, it, vi } from 'vitest';

const created: GlobeOptions[] = [];
vi.mock('@vibeglobe/core', async (original) => ({
  ...(await original<object>()),
  createGlobe: (options: GlobeOptions): Partial<Globe> => {
    created.push(options);
    return {
      ready: Promise.resolve(),
      camera: {
        longitudeDeg: 12.5,
        latitudeDeg: 41.9,
        zoom: 4,
        altitudeMeters: 0,
        headingDeg: 0,
        tiltDeg: 30,
        rollDeg: 0,
        rangeMeters: 0,
        eyeLongitudeDeg: 0,
        eyeLatitudeDeg: 0,
        groundHeightMeters: 0,
        viewMode: 'auto',
        chosenTiltDeg: 0,
        chosenHeadingDeg: 0,
        morphFactor: 0,
        reliefFactor: 0,
        phase: 'globe',
      },
      on: (() => () => undefined) as Globe['on'],
      jumpTo: vi.fn(),
      destroy: vi.fn(),
    };
  },
}));

const { defineVibeGlobe } = await import('./index.js');

describe('defineVibeGlobe', () => {
  it('registers only when called, under the given tag name, once', () => {
    expect(customElements.get('test-globe')).toBeUndefined();
    const element = defineVibeGlobe('test-globe');
    expect(customElements.get('test-globe')).toBe(element);
    expect(defineVibeGlobe('test-globe')).toBe(element);
  });

  it('mirrors properties and attributes and starts the engine with them when connected', () => {
    defineVibeGlobe('test-globe');
    const element = document.createElement('test-globe') as InstanceType<ReturnType<typeof defineVibeGlobe>>;
    element.setAttribute('center', '12.5, 41.9');
    element.zoom = 4;
    element.tiltDeg = 30;
    expect(element.center).toEqual({ longitudeDeg: 12.5, latitudeDeg: 41.9 });
    expect(element.getAttribute('zoom')).toBe('4');
    expect(element.getAttribute('tilt-deg')).toBe('30');
    element.setAttribute('base-imagery-url', '/base.jpg');
    element.setAttribute('heading-deg', 'not a number');
    document.body.append(element);
    expect(created.at(-1)?.view).toEqual({ longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 4, tiltDeg: 30 });
    expect(created.at(-1)?.baseImageryUrl).toBe('/base.jpg');
    expect(element.globe).toBeDefined();
    element.zoom = undefined;
    expect(element.hasAttribute('zoom')).toBe(false);
  });
});
