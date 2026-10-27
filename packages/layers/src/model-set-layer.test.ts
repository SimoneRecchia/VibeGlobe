import type { ModelPose, ModelRenderer, ModelSetOptions } from '@vibeglobe/core';
import { describe, expect, it } from 'vitest';
import { LayerStack } from './layer-stack.js';
import { ModelSetLayer } from './model-set-layer.js';
import { RecordingRenderTarget } from './testing.js';

/** A model renderer with sets that records what the layer tells it. */
function fakeSets(): ModelRenderer & {
  loads: { source: unknown; options: ModelSetOptions }[];
  instances: { poses: readonly ModelPose[]; pickIds: readonly number[] } | undefined;
  highlights: Map<number, readonly number[] | undefined>;
  visible: boolean;
  removed: number[];
} {
  const fake = {
    loads: [] as { source: unknown; options: ModelSetOptions }[],
    instances: undefined as { poses: readonly ModelPose[]; pickIds: readonly number[] } | undefined,
    highlights: new Map<number, readonly number[] | undefined>(),
    visible: true,
    removed: [] as number[],
    load: () => Promise.resolve(99),
    setPose: () => undefined,
    remove: (id: number) => void fake.removed.push(id),
    loadSet: (source: unknown, options: ModelSetOptions) => {
      fake.loads.push({ source, options });
      return Promise.resolve(7);
    },
    setInstances: (_id: number, poses: readonly ModelPose[], pickIds: readonly number[]) =>
      void (fake.instances = { poses, pickIds }),
    setInstanceHighlight: (_id: number, index: number, rgba: readonly number[] | undefined) =>
      void fake.highlights.set(index, rgba),
    setVisible: (_id: number, visible: boolean) => void (fake.visible = visible),
  };
  return fake;
}

describe('model set layer (F627)', () => {
  it('loads its model once for every copy, with poses and pick ids that resolve to them, and highlights a copy', async () => {
    const models = fakeSets();
    const stack = new LayerStack(Object.assign(new RecordingRenderTarget(), { models }));
    const turbines = Array.from({ length: 2000 }, (_, i) => ({
      id: `t${String(i)}`,
      position: { longitudeDeg: 9 + i * 0.001, latitudeDeg: 45 },
      headingDeg: 270,
      properties: { index: i },
    }));
    const layer = stack.add(new ModelSetLayer({ id: 'farm', url: 'turbine.glb', models: turbines }));
    await layer.ready;
    expect(models.loads).toEqual([
      {
        source: { url: 'turbine.glb' },
        options: { visibleBelowMeters: 3000, placeholderColor: [0.95, 0.95, 0.97], placeholderSizePx: 10 },
      },
    ]);
    expect(models.instances?.poses).toHaveLength(2000);
    expect(models.instances?.poses[5]).toEqual({ position: turbines[5]?.position, headingDeg: 270 });
    expect(stack.resolvePick(models.instances?.pickIds[1234] ?? 0)?.feature).toEqual({
      layerId: 'farm',
      id: 't1234',
      properties: { index: 1234 },
    });
    layer.setFeatureState('t3', { selected: true });
    expect(models.highlights.get(3)).toEqual([1, 1, 0, 0.6]);
    layer.setFeatureState('t3', undefined);
    expect(models.highlights.get(3)).toBeUndefined();
    layer.setFeaturePosition('t3', 10, 46);
    expect(models.instances?.poses[3]?.position).toEqual({ longitudeDeg: 10, latitudeDeg: 46, heightMeters: 0 });
    layer.setVisible(false);
    expect(models.visible).toBe(false);
    stack.remove('farm');
    expect(models.removed).toEqual([7]);
  });

  it('takes its distance and placeholder, and refuses a missing file or a bad distance', () => {
    expect(() => new ModelSetLayer({ models: [] })).toThrow(RangeError);
    expect(() => new ModelSetLayer({ url: 'a.glb', models: [], visibleBelowMeters: -1 })).toThrow(RangeError);
    const models = fakeSets();
    const stack = new LayerStack(Object.assign(new RecordingRenderTarget(), { models }));
    stack.add(
      new ModelSetLayer({
        url: 'a.glb',
        models: [],
        visibleBelowMeters: 1500,
        placeholder: { color: [0, 0, 1], sizePx: 0 },
      }),
    );
    expect(models.loads[0]?.options).toEqual({
      visibleBelowMeters: 1500,
      placeholderColor: [0, 0, 1],
      placeholderSizePx: 0,
    });
  });
});
