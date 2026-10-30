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
        maxTiltDeg: 90,
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

  it('applies only the attribute that changed, keeping the view the user navigated to (KB-145)', async () => {
    defineVibeGlobe('test-globe');
    const element = document.createElement('test-globe') as InstanceType<ReturnType<typeof defineVibeGlobe>>;
    element.setAttribute('center', '12.5, 41.9');
    element.setAttribute('zoom', '4');
    document.body.append(element);
    const globe = element.globe as unknown as { camera: { longitudeDeg: number }; jumpTo: ReturnType<typeof vi.fn> };
    // The user pans away from the center attribute.
    globe.camera.longitudeDeg = 20;
    element.setAttribute('theme', 'dark');
    element.setAttribute('lang', 'it');
    expect(globe.jumpTo).not.toHaveBeenCalled();
    element.setAttribute('zoom', '6');
    expect(globe.jumpTo).toHaveBeenCalledExactlyOnceWith({ zoom: 6 });
    element.remove();
    await Promise.resolve();
  });

  it('keeps properties set before the element was defined (PT-01)', () => {
    const element = document.createElement('early-globe') as InstanceType<ReturnType<typeof defineVibeGlobe>>;
    const imagery = [{ id: 'early' }] as unknown as typeof element.imagery;
    element.zoom = 5;
    element.imagery = imagery;
    element.setAttribute('base-imagery-url', '/base.jpg');
    document.body.append(element);
    defineVibeGlobe('early-globe');
    expect(element.getAttribute('zoom')).toBe('5');
    expect(created.at(-1)?.view).toEqual({ zoom: 5 });
    expect(created.at(-1)?.imagery).toEqual(imagery);
    element.zoom = 6;
    expect(element.getAttribute('zoom')).toBe('6');
    element.remove();
  });
});
