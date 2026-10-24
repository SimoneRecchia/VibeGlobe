// @vitest-environment happy-dom
// F477: the component renders a placeholder on the server, creates no engine there, and starts the engine on the
// client only after hydration.
import type { Globe, GlobeOptions } from '@vibeglobe/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSSRApp, h, nextTick } from 'vue';
import { renderToString } from 'vue/server-renderer';

const created: GlobeOptions[] = [];
const handlers = new Map<string, (payload: unknown) => void>();

vi.mock('@vibeglobe/core', async (original) => ({
  ...(await original<object>()),
  createGlobe: (options: GlobeOptions): Partial<Globe> => {
    created.push(options);
    return {
      ready: Promise.resolve(),
      camera: {
        longitudeDeg: 0,
        latitudeDeg: 0,
        zoom: 2,
        altitudeMeters: 0,
        headingDeg: 0,
        tiltDeg: 0,
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
      on: ((event: string, handler: (payload: unknown) => void) => {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      }) as Globe['on'],
      jumpTo: vi.fn(),
      destroy: vi.fn(),
    };
  },
}));

const { VibeGlobe } = await import('./index.js');

function app(): ReturnType<typeof createSSRApp> {
  return createSSRApp({
    render: () =>
      h(
        VibeGlobe,
        { baseImageryUrl: '/base.jpg', zoom: 2 },
        { placeholder: () => [h('p', { class: 'loading' }, 'Loading the globe')] },
      ),
  });
}

afterEach(() => {
  created.length = 0;
  handlers.clear();
  document.body.innerHTML = '';
});

describe('VibeGlobe under server-side rendering', () => {
  it('renders the placeholder on the server and creates no engine', async () => {
    const html = await renderToString(app());
    expect(html).toContain('data-vibeglobe-placeholder');
    expect(html).toContain('Loading the globe');
    expect(html).not.toContain('<canvas');
    expect(created).toHaveLength(0);
  });

  it('hydrates without a mismatch and starts the engine after mount', async () => {
    const root = document.createElement('div');
    root.innerHTML = await renderToString(app());
    document.body.append(root);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const hydrated = app();
    hydrated.mount(root);
    expect(created).toHaveLength(1);
    expect(created[0]?.container).toBe(root.querySelector('.vibeglobe-engine'));
    expect(created[0]?.view).toEqual({ zoom: 2 });
    // The placeholder stays until the engine reports its first frame.
    handlers.get('ready')?.({ backend: 'webgl2' });
    await nextTick();
    expect(root.querySelector('[data-vibeglobe-placeholder]')).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    hydrated.unmount();
    warn.mockRestore();
    error.mockRestore();
  });
});

describe('camera props (F474)', () => {
  it('a changed camera prop moves only its own field, keeping where the user navigated the others (KB-146)', async () => {
    const { changedView } = await import('./globe-config.js');
    // The user panned to 20° E; the parent then changes only the zoom prop.
    const camera = { longitudeDeg: 20, latitudeDeg: 41.9, zoom: 5, headingDeg: 0, tiltDeg: 0 } as Globe['camera'];
    const previous = { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 5 };
    expect(changedView(camera, { ...previous, zoom: 6 }, previous)).toEqual({ zoom: 6 });
    // Without a previous value every prop applies (the first watch, or a new prop).
    expect(changedView(camera, { longitudeDeg: 12.5 })).toEqual({ longitudeDeg: 12.5 });
  });
});

describe('VibeDataLayer features (F476)', () => {
  it('replaces features without ids instead of adding them next to the previous ones (KB-147)', async () => {
    const { replaceFeatures } = await import('./children.js');
    const ids = new Set<string | number>();
    const layer = {
      addFeatures: (features: readonly { id?: string | number }[]) => {
        for (const f of features) ids.add(f.id ?? `generated-${String(ids.size)}`);
      },
      removeFeature: (id: string | number) => ids.delete(id),
    };
    const point = (lon: number) =>
      ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, 0] }, properties: {} }) as const;
    let shown = replaceFeatures(layer, [], [point(12.5)], 'dots');
    shown = replaceFeatures(layer, shown, [point(14)], 'dots');
    replaceFeatures(layer, shown, [point(15)], 'dots');
    expect(ids.size).toBe(1);
  });
});
