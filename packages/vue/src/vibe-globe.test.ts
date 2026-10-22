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
