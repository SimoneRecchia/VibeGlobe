/* This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
 * distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { MorphFrame, type BatchKind, type FeatureGeometry, type FrameView } from '@vibeglobe/core';
import { Scene, type BufferAttribute, type Mesh, type Texture } from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LayerBatches } from './layer-batches.js';

/** The atlas's 2D canvas: Node has none, and nothing is drawn into it here. */
class StubCanvas {
  width = 0;
  height = 0;
  getContext(): object {
    return {};
  }
}

describe('LayerBatches.restore', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('gives the atlas a new texture of the same image, so the lost renderer listening to the old one is not kept (KB-222)', () => {
    vi.stubGlobal('OffscreenCanvas', StubCanvas);
    const batches = new LayerBatches(new Scene(), 'reversed-z');
    const atlas = (batches as unknown as { atlas: { texture: Texture } }).atlas;
    const lost = atlas.texture;
    // A disposed renderer no longer removes the listener it added: the texture holding it must not be kept.
    const listener = (): void => undefined;
    lost.addEventListener('dispose', listener);
    batches.restore('reversed-z');
    expect(atlas.texture).not.toBe(lost);
    expect(atlas.texture.hasEventListener('dispose', listener)).toBe(false);
    expect(atlas.texture.image).toBe(lost.image);
    expect(atlas.texture.version).toBeGreaterThan(0);
  });
});

const VIEW: FrameView = {
  morph: new MorphFrame(),
  view: new Float64Array(16),
  projection: new Float64Array(16),
  eyeEcef: new Float64Array(3),
  widthPx: 400,
  heightPx: 300,
  pixelRatio: 1,
};

/** A square ring `sizeDeg` across, its south-west corner `eastDeg` east of 15° E, 41° N. */
function square(sizeDeg: number, eastDeg = 0): FeatureGeometry {
  const [w, s, e, n] = [15 + eastDeg, 41, 15 + eastDeg + sizeDeg, 41 + sizeDeg];
  return { positions: Float64Array.of(w, s, 0, e, s, 0, e, n, 0, w, n, 0, w, s, 0), partStarts: Uint32Array.of(0) };
}

/** Batches over a terrain `level` meters high everywhere, with one draped batch of `squares` drawn once. */
function draped(kind: BatchKind, squares: readonly FeatureGeometry[]) {
  vi.stubGlobal('OffscreenCanvas', StubCanvas);
  const scene = new Scene();
  const batches = new LayerBatches(scene, 'reversed-z');
  const terrain = { level: 100, version: 1 };
  batches.setGround({ heightAt: () => terrain.level, version: () => terrain.version });
  const handle = batches.createBatch({ kind, layerId: 'test', capacity: squares.length, placement: 'drape' });
  squares.forEach((geometry, feature) => batches.writeGeometry(handle, feature, geometry));
  batches.setCount(handle, squares.length);
  batches.place(VIEW);
  const mesh = scene.children[0] as Mesh;
  const values = (name: string): number[] => {
    const attribute = mesh.geometry.getAttribute(name) as BufferAttribute;
    return Array.from({ length: attribute.count * attribute.itemSize }, (_, i) =>
      attribute.getComponent((i / attribute.itemSize) | 0, i % attribute.itemSize),
    );
  };
  return { scene, batches, terrain, handle, mesh, values };
}

describe('LayerBatches on the terrain', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(['polygon', 'polyline'] as const)(
    'stands a draped %s on newer terrain by its heights alone, without rebuilding it (KB-349)',
    (kind) => {
      const { scene, batches, terrain, mesh, values } = draped(kind, [square(0.02)]);
      expect(new Set(values('layerHeight'))).toEqual(new Set([100]));
      terrain.level = 250;
      terrain.version = 2;
      batches.place(VIEW);
      expect(batches.stats().rebuilds).toBe(1);
      expect(scene.children[0]).toBe(mesh);
      expect(new Set(values('layerHeight'))).toEqual(new Set([250]));
      if (kind === 'polyline') expect(new Set(values('otherHeight'))).toEqual(new Set([250]));
    },
  );

  it('rewrites clamped points in place on newer terrain: their batch is not rebuilt either (KB-349)', () => {
    vi.stubGlobal('OffscreenCanvas', StubCanvas);
    const scene = new Scene();
    const batches = new LayerBatches(scene, 'reversed-z');
    const terrain = { level: 100, version: 1 };
    batches.setGround({ heightAt: () => terrain.level, version: () => terrain.version });
    const handle = batches.createBatch({ kind: 'point', layerId: 'test', capacity: 2, placement: 'clamp-to-ground' });
    batches.writeRange(handle, 'position', 0, 2, Float64Array.of(15, 41, 0, 15.1, 41, 5));
    batches.setCount(handle, 2);
    batches.place(VIEW);
    terrain.level = 250;
    terrain.version = 2;
    batches.place(VIEW);
    const heights = (scene.children[0] as Mesh).geometry.getAttribute('layerHeight') as BufferAttribute;
    expect(batches.stats().rebuilds).toBe(1);
    expect(Array.from(heights.array)).toEqual([250, 250, 250, 250, 255, 255, 255, 255]);
  });

  it('leaves a hidden batch on the terrain it has until it shows again (KB-349)', () => {
    const { batches, terrain, handle, values } = draped('polygon', [square(0.02)]);
    batches.setVisible(handle, false);
    terrain.level = 250;
    terrain.version = 2;
    batches.place(VIEW);
    expect(new Set(values('layerHeight'))).toEqual(new Set([100]));
    batches.setVisible(handle, true);
    batches.place(VIEW);
    expect(new Set(values('layerHeight'))).toEqual(new Set([250]));
    expect(batches.stats().rebuilds).toBe(1);
  });

  it.each(['polygon', 'polyline'] as const)(
    'recolors one feature of a %s batch in place: no rebuild, and only its vertices change (KB-350)',
    (kind) => {
      const { batches, handle, values } = draped(kind, [square(0.02), square(0.02, 0.05)]);
      const before = values('layerColor');
      batches.writeRange(handle, 'color', 1, 1, Float64Array.of(0, 0, 0, 1, 1, 0, 0, 0.5));
      batches.place(VIEW);
      const after = values('layerColor');
      expect(batches.stats()).toMatchObject({ rebuilds: 1, rangeUploads: 1 });
      expect(after.slice(0, after.length / 2)).toEqual(before.slice(0, before.length / 2));
      expect(after.slice(-4)).toEqual([1, 0, 0, 0.5]);
    },
  );

  it('drapes a polygon half a kilometer across in pieces that follow the relief, not as two flat triangles (KB-351)', () => {
    const { mesh } = draped('polygon', [square(0.005)]);
    expect(mesh.geometry.getAttribute('position').count / 3).toBeGreaterThan(32);
  });
});
