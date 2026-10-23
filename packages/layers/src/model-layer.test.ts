import type { ModelPose, ModelRenderer } from '@vibeglobe/core';
import { describe, expect, it } from 'vitest';
import { LayerStack } from './layer-stack.js';
import { ModelLayer } from './model-layer.js';
import { RecordingRenderTarget } from './testing.js';

/** A model renderer that records what the layer tells it. */
function fakeModels(): ModelRenderer & {
  poses: Map<number, ModelPose>;
  pickIds: Map<number, number>;
  highlights: Map<number, readonly number[] | undefined>;
  removed: number[];
} {
  let next = 1;
  const poses = new Map<number, ModelPose>();
  const pickIds = new Map<number, number>();
  const highlights = new Map<number, readonly number[] | undefined>();
  const removed: number[] = [];
  return {
    poses,
    pickIds,
    highlights,
    removed,
    load: (source) => (source.url === 'broken.gltf' ? Promise.reject(new Error('corrupt')) : Promise.resolve(next++)),
    setPose: (id, pose) => poses.set(id, pose),
    remove: (id) => removed.push(id),
    setPickId: (id, pickId) => pickIds.set(id, pickId),
    setHighlight: (id, rgba) => highlights.set(id, rgba),
  };
}

describe('model layer (F379, F381)', () => {
  it('loads its models with poses and pick ids that resolve to them, highlights the selected one and moves it', async () => {
    const models = fakeModels();
    const stack = new LayerStack(Object.assign(new RecordingRenderTarget(), { models }));
    const errors: string[] = [];
    const layer = new ModelLayer({
      id: 'models',
      models: [
        { id: 'a', url: 'a.gltf', position: { longitudeDeg: 12, latitudeDeg: 41 }, scale: 10 },
        { id: 'b', url: 'broken.gltf', position: { longitudeDeg: 13, latitudeDeg: 42 } },
        { id: 'c', url: 'c.gltf', position: { longitudeDeg: 14, latitudeDeg: 43 }, properties: { kind: 'tower' } },
      ],
    });
    layer.on('error', ({ message }) => errors.push(message));
    stack.add(layer);
    await layer.ready;
    expect(errors).toEqual(['Model b could not be loaded']);
    expect([...models.poses.values()].map((p) => p.position.longitudeDeg)).toEqual([12, 14]);
    expect(models.poses.get(1)?.scale).toBe(10);
    const resolved = [...models.pickIds.values()].map((id) => stack.resolvePick(id)?.feature);
    expect(resolved).toEqual([
      { layerId: 'models', id: 'a', properties: {} },
      { layerId: 'models', id: 'c', properties: { kind: 'tower' } },
    ]);
    // Selected: highlighted; hover alone a lighter blend; cleared, none.
    layer.setFeatureState('c', { selected: true });
    expect(models.highlights.get(2)).toEqual([1, 1, 0, 0.6]);
    layer.setFeatureState('c', { selected: false, hover: true });
    expect(models.highlights.get(2)).toEqual([1, 1, 1, 0.25]);
    layer.setFeatureState('c', undefined);
    expect(models.highlights.get(2)).toBeUndefined();
    expect(layer.setFeaturePosition('a', 12.5, 41.5, 100)).toBe(true);
    expect(models.poses.get(1)).toEqual({
      position: { longitudeDeg: 12.5, latitudeDeg: 41.5, heightMeters: 100 },
      scale: 10,
    });
    stack.remove(layer);
    expect(models.removed).toEqual([1, 2]);
    expect(stack.resolvePick(models.pickIds.get(1) ?? 0)).toBeUndefined();
  });

  it('drops its event handlers when removed from the stack, as data layers do (KB-115, F385)', async () => {
    const models = fakeModels();
    const stack = new LayerStack(Object.assign(new RecordingRenderTarget(), { models }));
    const layer = new ModelLayer({
      id: 'models',
      models: [{ id: 'a', url: 'a.gltf', position: { longitudeDeg: 12, latitudeDeg: 41 } }],
    });
    layer.on('click', () => undefined);
    stack.add(layer);
    await layer.ready;
    stack.remove(layer);
    expect(layer.listenerCount).toBe(0);
  });
});
