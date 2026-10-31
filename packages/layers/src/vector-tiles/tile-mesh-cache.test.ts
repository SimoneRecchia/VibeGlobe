// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { describe, expect, it, vi } from 'vitest';
import { TileGrounds } from './drape.js';
import { StyleLayer } from './style-layer.js';
import { DEFERRED, PaintStamps, TileMeshCache, type MeshSource } from './tile-mesh-cache.js';
import type { TileId } from './tile-pyramid.js';
import type { VectorMesh, VectorTileTarget } from './vector-target.js';

/** A cache over a fake clock, where building a mesh takes 5 ms. */
function slowCache() {
  const clock = { ms: 0 };
  const built: VectorMesh[] = [];
  const target = {
    createMesh: () => {
      clock.ms += 5;
      const mesh = { update: vi.fn(), dispose: vi.fn() };
      built.push(mesh);
      return mesh;
    },
  } as unknown as VectorTileTarget;
  const sample = { heightMeters: 0, level: -1, noData: true };
  const grounds = new TileGrounds({
    camera: { reliefFactor: 1 },
    elevationAt: () => sample,
    terrainStats: () => undefined,
  });
  const cache = new TileMeshCache(
    () => target,
    grounds,
    () => undefined,
    () => undefined,
    () => clock.ms,
  );
  return { cache, clock, built };
}

const background = new StyleLayer({ id: 'bg', type: 'background', paint: { 'background-color': '#123456' } });
const square = (tile: TileId): MeshSource => ({ sourceId: '', loaded: undefined, tile });

describe('mesh building within a frame budget (KB-244)', () => {
  it('builds meshes until the budget is spent, at least one per frame, and the rest in the next frames', () => {
    const { cache, built } = slowCache();
    const tiles = [0, 1, 2, 3].map((x) => square({ z: 2, x, y: 0 }));
    cache.beginFrame();
    const first = tiles.map((t) => cache.get(t, background, 2, 1, 1));
    expect(first.map((m) => m === DEFERRED)).toEqual([false, false, true, true]);
    expect(cache.pending).toBe(true);
    cache.beginFrame();
    const second = tiles.map((t) => cache.get(t, background, 2, 1, 2));
    expect(second.every((m) => m !== DEFERRED && m !== undefined)).toBe(true);
    expect(built).toHaveLength(4);
    expect(cache.pending).toBe(false);
  });

  it('defers a new zoom pair past the budget, drawing the mesh with its former pair, but repaints a paint change', () => {
    const { cache, built } = slowCache();
    cache.beginFrame();
    cache.get(square({ z: 2, x: 0, y: 0 }), background, 2, 1, 1);
    cache.get(square({ z: 2, x: 1, y: 0 }), background, 2, 1, 1);
    // The budget is spent: a new zoom pair keeps the first mesh's paint for now, a new paint version does not wait.
    expect(cache.get(square({ z: 2, x: 0, y: 0 }), background, 3, 1, 1)).toEqual({ mesh: built[0], zoomA: 2 });
    expect(built[0]?.update).not.toHaveBeenCalled();
    expect(cache.get(square({ z: 2, x: 1, y: 0 }), background, 2, 2, 1)).toEqual({ mesh: built[1], zoomA: 2 });
    expect(built[1]?.update).toHaveBeenCalledTimes(1);
    cache.beginFrame();
    expect(cache.get(square({ z: 2, x: 0, y: 0 }), background, 3, 1, 2)).toEqual({ mesh: built[0], zoomA: 3 });
    expect(built[0]?.update).toHaveBeenCalledTimes(1);
  });

  it('stands in for a waiting tile with the kept mesh of a tile around it, else with its children', () => {
    const { cache, built } = slowCache();
    cache.beginFrame();
    cache.get(square({ z: 1, x: 0, y: 0 }), background, 1, 1, 1);
    expect(cache.standIns('', { z: 3, x: 1, y: 2 }, 'bg', undefined, 1)).toEqual([
      { mesh: built[0], zoomA: 1, tile: { z: 1, x: 0, y: 0 } },
    ]);
    cache.beginFrame();
    cache.get(square({ z: 4, x: 8, y: 8 }), background, 4, 1, 2);
    cache.beginFrame();
    cache.get(square({ z: 4, x: 9, y: 9 }), background, 4, 1, 3);
    expect(cache.standIns('', { z: 3, x: 4, y: 4 }, 'bg', undefined, 3).map((s) => s.tile)).toEqual([
      { z: 4, x: 8, y: 8 },
      { z: 4, x: 9, y: 9 },
    ]);
    expect(cache.standIns('', { z: 3, x: 4, y: 4 }, 'other', undefined, 3)).toEqual([]);
  });
});

describe('paint versions per layer (KB-244)', () => {
  it('restamps only the changed layer for a paint change, every layer for a feature state, none for visibility', () => {
    const stamps = new PaintStamps();
    const [a0, b0] = [stamps.of('a'), stamps.of('b')];
    stamps.changed({ kind: 'paint', layerId: 'a' });
    expect(stamps.of('a')).toBeGreaterThan(a0);
    expect(stamps.of('b')).toBe(b0);
    stamps.changed({ kind: 'visibility', layerId: 'b' });
    stamps.changed({ kind: 'zoom-range', layerId: 'b' });
    expect(stamps.of('b')).toBe(b0);
    const a1 = stamps.of('a');
    stamps.featureStateChanged();
    expect(stamps.of('a')).toBeGreaterThan(a1);
    expect(stamps.of('b')).toBeGreaterThan(b0);
  });
});
