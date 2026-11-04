// @vitest-environment happy-dom
// F696: one call starts the globe with the application's services; tiles are required, terrain and geocoder optional.
import type { GlobeOptions, TerrainSource, TileService } from '@vibeglobe/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const created: GlobeOptions[] = [];
const destroyed = vi.fn();
const controls = { add: vi.fn(), all: vi.fn(), destroyUi: vi.fn() };
const vector = { add: vi.fn(), remove: vi.fn(), setLanguage: vi.fn() };
vi.mock('@vibeglobe/core', async (original) => ({
  ...(await original<object>()),
  createGlobe: (options: GlobeOptions) => {
    created.push(options);
    return { ready: Promise.resolve(), destroy: destroyed };
  },
}));
vi.mock('@vibeglobe/renderer', () => ({ createRenderer: () => 'renderer' }));
vi.mock('@vibeglobe/renderer/vector-tiles', () => ({ createVectorTileTarget: 'target' }));
vi.mock('@vibeglobe/worker', () => ({ createWorkers: () => 'workers' }));
vi.mock('@vibeglobe/controls', () => ({ createControls: () => 'controls' }));
vi.mock('@vibeglobe/ui', () => ({
  createUi: () => ({ destroy: controls.destroyUi }),
  addDefaultControls: controls.add,
  addAllControls: controls.all,
}));
vi.mock('@vibeglobe/layers/vector-tiles', () => ({
  addVectorTiles: async (_globe: unknown, options: { style: unknown }) => {
    vector.add(options);
    if (options.style === 'broken.json') throw new Error('HTTP 404');
    return { remove: vector.remove, setLanguage: vector.setLanguage };
  },
}));

const { createVibeGlobe } = await import('./index.js');
const container = (): HTMLElement => document.createElement('div');
const imagery = { id: 'satellite' } as never;
const tiles: TileService = { imagery: () => [imagery] };

beforeEach(() => {
  created.length = 0;
  vi.clearAllMocks();
});

describe('createVibeGlobe', () => {
  it('refuses to start without a tile service', async () => {
    await expect(createVibeGlobe(container(), {} as never)).rejects.toMatchObject({ code: 'invalid-option' });
    expect(created).toHaveLength(0);
  });

  it('starts with only the tiles: no terrain, and a search box for coordinates only', async () => {
    const { globe, ui } = await createVibeGlobe(container(), { tiles, view: { zoom: 3 } });
    expect(globe).toBeDefined();
    expect(ui).toBeDefined();
    expect(created[0]).toMatchObject({
      imagery: [imagery],
      workers: 'workers',
      controls: 'controls',
      view: { zoom: 3 },
    });
    expect(created[0]).not.toHaveProperty('terrain');
    expect(created[0]?.baseImageryUrl).toMatch(/^data:image\/png/);
    expect(controls.add).toHaveBeenCalledWith(ui, {});
    expect(vector.add).not.toHaveBeenCalled();
  });

  it('uses the terrain and geocoder services when given, and every control with ui: all', async () => {
    const terrain = { id: 'dem' } as TerrainSource;
    const geocoder = { search: async () => [] };
    const { ui } = await createVibeGlobe(container(), {
      tiles,
      terrain: { terrain: () => terrain },
      geocoder,
      ui: 'all',
      controls: false,
    });
    expect(created[0]).toMatchObject({ terrain, creditsElement: false });
    expect(created[0]).not.toHaveProperty('controls');
    expect(controls.all).toHaveBeenCalledWith(ui, { geocoder });
  });

  it('draws the tile service style over its imagery, in the language asked, and removes it on destroy', async () => {
    const styled: TileService = {
      imagery: () => [],
      style: () => 'https://maps.test/style.json',
      transformUrl: (url) => `${url}?key=k`,
    };
    const started = await createVibeGlobe(container(), { tiles: styled, ui: false, language: 'it' });
    expect(started.ui).toBeUndefined();
    const options = vector.add.mock.calls[0]?.[0] as { style: string; transformUrl: (url: string) => string };
    expect(options.style).toBe('https://maps.test/style.json');
    expect(options.transformUrl('https://maps.test/t.pbf')).toBe('https://maps.test/t.pbf?key=k');
    expect(vector.setLanguage).toHaveBeenCalledWith('it');
    started.destroy();
    expect(vector.remove).toHaveBeenCalled();
    expect(destroyed).toHaveBeenCalled();
  });

  it('stops everything and rejects when the style does not load', async () => {
    const broken: TileService = { imagery: () => [], style: () => 'broken.json' };
    await expect(createVibeGlobe(container(), { tiles: broken })).rejects.toMatchObject({ code: 'resource-failed' });
    expect(destroyed).toHaveBeenCalled();
    expect(controls.destroyUi).toHaveBeenCalled();
  });
});
