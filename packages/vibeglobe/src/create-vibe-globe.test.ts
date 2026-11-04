// @vitest-environment happy-dom
// F699: one call starts the globe with the application's services; tiles are required, terrain and geocoder optional.
import type { GlobeOptions, TerrainSource } from '@vibeglobe/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const created: GlobeOptions[] = [];
const spies = { destroy: vi.fn(), controls: vi.fn(), destroyUi: vi.fn(), remove: vi.fn(), setLanguage: vi.fn() };
vi.mock('@vibeglobe/core', async (original) => ({
  ...(await original<object>()),
  createGlobe: (options: GlobeOptions) => (created.push(options), { ready: Promise.resolve(), destroy: spies.destroy }),
}));
vi.mock('@vibeglobe/renderer', () => ({ createRenderer: () => 'renderer' }));
vi.mock('@vibeglobe/renderer/vector-tiles', () => ({ createVectorTileTarget: 'target' }));
vi.mock('@vibeglobe/worker', () => ({ createWorkers: () => 'workers' }));
vi.mock('@vibeglobe/controls', () => ({ createControls: () => 'controls' }));
vi.mock('@vibeglobe/ui', () => ({
  createUi: () => ({ destroy: spies.destroyUi }),
  addDefaultControls: spies.controls,
}));
vi.mock('@vibeglobe/layers/vector-tiles', () => ({
  addVectorTiles: async (_globe: unknown, { style }: { style: string }) => {
    if (style === 'broken.json') throw new Error('HTTP 404');
    return { remove: spies.remove, setLanguage: spies.setLanguage };
  },
}));

const { createVibeGlobe } = await import('./index.js');
const container = (): HTMLElement => document.createElement('div');
const imagery = [{ id: 'satellite' }] as never;

beforeEach(() => {
  created.length = 0;
  vi.clearAllMocks();
});

describe('createVibeGlobe', () => {
  it('refuses to start without a tile service', async () => {
    await expect(createVibeGlobe(container(), {} as never)).rejects.toMatchObject({ code: 'invalid-option' });
    expect(created).toEqual([]);
  });

  it('starts with only the tiles: a flat surface and a search box for coordinates', async () => {
    const { ui } = await createVibeGlobe(container(), { tiles: { imagery }, view: { zoom: 3 } });
    expect(created[0]).toMatchObject({ imagery, workers: 'workers', controls: 'controls', view: { zoom: 3 } });
    expect(created[0]).not.toHaveProperty('terrain');
    expect(created[0]?.baseImageryUrl).toMatch(/^data:image\/png/);
    expect(spies.controls).toHaveBeenCalledWith(ui, {});
  });

  it('uses the terrain and the geocoder when given', async () => {
    const terrain = { id: 'dem' } as TerrainSource;
    const geocoder = { search: async () => [] };
    const { ui } = await createVibeGlobe(container(), { tiles: { imagery }, terrain, geocoder, controls: false });
    expect(created[0]).toMatchObject({ terrain });
    expect(created[0]).not.toHaveProperty('controls');
    expect(spies.controls).toHaveBeenCalledWith(ui, { geocoder });
  });

  it('draws the style in the language asked, removed on destroy; a style that fails stops everything', async () => {
    const started = await createVibeGlobe(container(), {
      tiles: { imagery: [], style: 'a.json' },
      ui: false,
      language: 'it',
    });
    expect(started.ui).toBeUndefined();
    expect(spies.setLanguage).toHaveBeenCalledWith('it');
    started.destroy();
    expect(spies.remove).toHaveBeenCalled();
    const broken = createVibeGlobe(container(), { tiles: { imagery: [], style: 'broken.json' } });
    await expect(broken).rejects.toMatchObject({ code: 'resource-failed' });
    expect(spies.destroyUi).toHaveBeenCalled();
    expect(spies.destroy).toHaveBeenCalledTimes(2);
  });
});
