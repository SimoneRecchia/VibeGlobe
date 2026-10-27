// @vitest-environment happy-dom
import type { CameraState, Globe, GlobeEvents } from '@vibeglobe/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CameraTween } from './animation.js';
import { CompassControl } from './controls/compass.js';
import { CoordinateReadoutControl } from './controls/readout.js';
import { DebugToggleControl } from './controls/debug-toggle.js';
import { SearchControl, type Geocoder } from './controls/search.js';
import { ViewModeControl } from './controls/view-mode.js';
import { ZoomControl } from './controls/zoom.js';
import { addDefaultControls } from './defaults.js';
import { createUi, type ControlContext, type Ui, type UiControl } from './ui.js';

/** A globe double with the public API the controls use: a camera that `jumpTo` and `flyTo` change, and its events. */
function fakeGlobe(): Globe & { emit(): void } {
  let camera: CameraState = {
    longitudeDeg: 9.19,
    latitudeDeg: 45.4642,
    zoom: 5,
    altitudeMeters: 1e6,
    headingDeg: 0,
    tiltDeg: 0,
    rollDeg: 0,
    rangeMeters: 1e6,
    eyeLongitudeDeg: 9.19,
    eyeLatitudeDeg: 45.4642,
    groundHeightMeters: 0,
    viewMode: 'auto',
    chosenTiltDeg: 0,
    chosenHeadingDeg: 0,
    morphFactor: 0,
    reliefFactor: 0,
    phase: 'globe',
  };
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const globe = {
    get camera() {
      return camera;
    },
    backend: 'webgl2',
    jumpTo(target: Partial<CameraState>) {
      camera = { ...camera, ...target };
      globe.emit();
    },
    // Flights arrive at once in the double: the search box flies to a chosen place (F204, F208).
    flyTo(target: Partial<CameraState>) {
      globe.jumpTo(target);
      return Promise.resolve('completed');
    },
    screenToGeo: ({ xPx, yPx }: { xPx: number; yPx: number }) =>
      xPx < 0 ? undefined : { longitudeDeg: xPx / 10, latitudeDeg: yPx / 10 },
    on(event: keyof GlobeEvents, handler: (payload: unknown) => void) {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return () => set.delete(handler);
    },
    emit() {
      for (const handler of handlers.get('camera-change') ?? []) handler(camera);
      for (const handler of handlers.get('frame') ?? []) handler({ frameNumber: 1, tiles: 1 });
    },
    requestRender: () => undefined,
    surfaceStats: () => ({ tiles: 3, maxLevel: 2 }),
    rendererStats: () => ({ drawCalls: 3, triangles: 99 }),
    imageryStats: () => undefined,
    terrainStats: () => undefined,
  };
  return globe as unknown as Globe & { emit(): void };
}

const created: Ui[] = [];
function setup(): { globe: Globe & { emit(): void }; container: HTMLElement; ui: Ui } {
  const container = document.createElement('div');
  document.body.append(container);
  const globe = fakeGlobe();
  // Reduced motion: camera steps apply at once, so the tests need no animation frames.
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const ui = createUi(globe, container);
  created.push(ui);
  return { globe, container, ui };
}

afterEach(() => {
  for (const ui of created.splice(0)) ui.destroy();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const button = (root: ParentNode, name: string): HTMLButtonElement => {
  const found = root.querySelector<HTMLButtonElement>(`.vg-ui__button--${name}`);
  if (found === null) throw new Error(`no ${name} button`);
  return found;
};

describe('the UI layer (F418)', () => {
  it('mounts and unmounts controls individually and cleanly', () => {
    const { ui, container } = setup();
    addDefaultControls(ui);
    expect(ui.controls().map((control) => control.id)).toEqual(['search', 'zoom', 'compass', 'fullscreen', 'readout']);
    expect(container.querySelector('[data-control="debug"]')).toBeNull();
    expect(ui.remove('zoom')).toBe(true);
    expect(container.querySelector('[data-control="zoom"]')).toBeNull();
    expect(ui.remove('zoom')).toBe(false);
    expect(() => ui.add(new CompassControl())).toThrow(/already added/);
    ui.destroy();
    expect(container.children).toHaveLength(0);
    expect(document.adoptedStyleSheets).toHaveLength(0);
  });

  it('replaces a built-in control with a custom one and extends another', () => {
    const { ui, container, globe } = setup();
    addDefaultControls(ui);
    const destroyed: string[] = [];
    const custom: UiControl = {
      id: 'zoom',
      position: 'top-right',
      mount(context: ControlContext) {
        const element = document.createElement('button');
        element.textContent = context.i18n.t('zoom.in');
        element.addEventListener('click', () => context.globe.jumpTo({ zoom: context.globe.camera.zoom + 2 }));
        return element;
      },
      destroy: () => destroyed.push('custom'),
    };
    ui.replace(custom);
    const replaced = container.querySelector<HTMLButtonElement>('[data-control="zoom"]');
    replaced?.click();
    expect(globe.camera.zoom).toBe(7);
    expect(replaced?.parentElement?.className).toContain('top-right');

    class LoudCompass extends CompassControl {
      readonly turns: number[] = [];
      override faceHeading(headingDeg: number): void {
        this.turns.push(headingDeg);
        super.faceHeading(headingDeg);
      }
    }
    const loud = new LoudCompass();
    ui.replace(loud);
    button(container, 'compass').dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true }));
    expect(loud.turns).toEqual([90]);
    expect(globe.camera.headingDeg).toBe(90);
  });

  it('switches theme and language at runtime without rebuilding controls', () => {
    const { ui, container } = setup();
    ui.add(new ZoomControl());
    const zoomIn = button(container, 'zoom-in');
    ui.setTheme('dark');
    expect(ui.element.dataset['theme']).toBe('dark');
    ui.setLanguage('it');
    expect(zoomIn.getAttribute('aria-label')).toBe('Ingrandisci');
    expect(ui.element.lang).toBe('it');
    expect(button(container, 'zoom-in')).toBe(zoomIn);
  });
});

describe('controls', () => {
  it('a press on a control chains its step; input on the map cancels it (F419)', () => {
    const container = document.createElement('div');
    const globe = fakeGlobe();
    const frames = new Set<() => void>();
    Object.assign(globe, {
      timeMs: 0,
      on: (event: string, handler: () => void) => {
        if (event === 'frame') frames.add(handler);
        return () => frames.delete(handler);
      },
    });
    const tween = new CameraTween(globe, container, () => false);
    tween.to({ zoom: 6 });
    const control = document.createElement('div');
    control.className = 'vg-ui';
    container.append(control);
    control.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(tween.target).toEqual({ zoom: 6 });
    container.dispatchEvent(new Event('pointerdown'));
    expect(tween.target).toBeUndefined();
    expect(frames.size).toBe(0);
    tween.destroy();
  });

  it('zoom steps chain from the running target and stop at the limits (F419)', () => {
    const { ui, container, globe } = setup();
    ui.add(new ZoomControl({ maxZoom: 7 }));
    button(container, 'zoom-in').click();
    button(container, 'zoom-in').click();
    expect(globe.camera.zoom).toBe(7);
    expect(button(container, 'zoom-in').disabled).toBe(true);
    expect(button(container, 'zoom-out').disabled).toBe(false);
  });

  it('the compass shows the heading, resets north and orients by key (F420)', () => {
    const { ui, container, globe } = setup();
    ui.add(new CompassControl());
    globe.jumpTo({ headingDeg: 30 });
    const compass = button(container, 'compass');
    expect(compass.querySelector('svg')?.style.transform).toBe('rotate(-30deg)');
    expect(compass.getAttribute('aria-label')).toContain('heading 30°');
    compass.click();
    expect(globe.camera.headingDeg).toBe(0);
    compass.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(globe.camera.headingDeg).toBe(15);
    compass.dispatchEvent(new KeyboardEvent('keydown', { key: 'S', bubbles: true }));
    expect(globe.camera.headingDeg).toBe(180);
  });

  it('the debug toggle shows and hides the panel with the performance HUD (F428)', () => {
    const { ui, container, globe } = setup();
    ui.add(new DebugToggleControl());
    const toggle = button(container, 'debug');
    toggle.click();
    globe.emit();
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.vibeglobe-debug-overlay [data-metric="frame-time"]')).not.toBeNull();
    expect(container.querySelector('.vibeglobe-debug-overlay [data-metric="surface"]')?.textContent).toContain(
      'tiles 3',
    );
    toggle.click();
    expect(container.querySelector('.vibeglobe-debug-overlay')).toBeNull();
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
  });

  it('the readout formats the view center with the gis formats and switches format (F405)', async () => {
    const { ui, container } = setup();
    ui.add(new CoordinateReadoutControl());
    const text = (): string | null | undefined => container.querySelector('.vg-ui__readout-coordinates')?.textContent;
    expect(text()).toBe('45.46420°N 9.19000°E');
    button(container, 'readout-format').click();
    expect(text()).toBe('45°27′51.1″N 9°11′24.0″E');
    button(container, 'readout-format').click();
    expect(text()).toBe('32T 514853 5034537');
    ui.setLanguage('it');
    button(container, 'readout-format').click();
    expect(text()).toBe('45,46420°N 9,19000°E');
    await Promise.resolve();
  });

  it('the search box goes to typed coordinates and lists geocoder results (F405, F426)', async () => {
    const { ui, container, globe } = setup();
    const geocoder: Geocoder = {
      search: () => Promise.resolve([{ label: 'Rome', longitudeDeg: 12.5, latitudeDeg: 41.9 }]),
    };
    ui.add(new SearchControl({ geocoder, debounceMs: 0 }));
    const input = container.querySelector<HTMLInputElement>('input[role="combobox"]');
    if (input === null) throw new Error('no input');
    const type = (value: string): void => {
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    type('33°52′07.68″S 151°12′33.48″E');
    expect(container.querySelector('[role="option"]')?.textContent).toBe('Go to 33.86880°S 151.20930°E');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(globe.camera.latitudeDeg).toBeCloseTo(-33.8688, 9);
    expect(globe.camera.zoom).toBe(12);
    type('Rome');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect([...container.querySelectorAll('[role="option"]')].map((item) => item.textContent)).toEqual(['Rome']);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(globe.camera.longitudeDeg).toBe(12.5);
  });

  it('the search box without a geocoder offers coordinate input only', () => {
    const { ui, container } = setup();
    ui.add(new SearchControl());
    const input = container.querySelector<HTMLInputElement>('input');
    if (input === null) throw new Error('no input');
    input.value = 'Rome';
    input.dispatchEvent(new Event('input'));
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Type coordinates, for example 45.4642, 9.19');
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(0);
  });
});

describe('the 2D / 3D / Auto toggle with a tilt policy (F625)', () => {
  it('disables 3D while the controls say the camera may not tilt, and enables it again', () => {
    const { container, ui } = setup();
    let notify: ((available: boolean) => void) | undefined;
    const tilt = {
      tiltAvailable: false,
      onTiltAvailabilityChange(listener: (available: boolean) => void) {
        notify = listener;
        return () => (notify = undefined);
      },
    };
    ui.add(new ViewModeControl({ tilt }));
    expect(button(container, 'view-3d').disabled).toBe(true);
    expect(button(container, 'view-2d').disabled).toBe(false);
    notify?.(true);
    expect(button(container, 'view-3d').disabled).toBe(false);
    ui.remove('view-mode');
    expect(notify).toBeUndefined();
  });
});
