import { describe, expect, it } from 'vitest';
import { FeatureStore } from './feature-store.js';
import { RecordingRenderTarget } from './render-target.js';

function filled(count: number): { store: FeatureStore; target: RecordingRenderTarget; handle: { id: number } } {
  const store = new FeatureStore(16);
  for (let i = 0; i < count; i++) {
    const index = store.add(`f${i}`, {});
    store.set('position', index, [i * 0.001, 0, 0]);
  }
  const target = new RecordingRenderTarget();
  const handle = target.createBatch({
    kind: 'point',
    layerId: 't',
    capacity: store.capacity,
    placement: 'clamp-to-ground',
  });
  store.flush(target, handle);
  target.clearWrites();
  return { store, target, handle };
}

describe('feature store', () => {
  it('uploads only the changed feature after a single-feature update (F376, F377)', () => {
    const { store, target, handle } = filled(100_000);
    const index = store.indexOf('f4242') as number;
    store.set('position', index, [10, 20, 30]);
    store.set('color', index, [1, 0, 0, 1]);
    store.setScalar('visible', index, 1);
    store.flush(target, handle);
    expect(target.writes).toEqual([
      { batch: handle.id, attribute: 'position', first: index, count: 1 },
      { batch: handle.id, attribute: 'color', first: index, count: 1 },
      { batch: handle.id, attribute: 'visible', first: index, count: 1 },
    ]);
    expect(target.value(handle, 'position', index, 1)).toBe(20);
    target.clearWrites();
    store.set('position', index, [10, 20, 30]);
    store.flush(target, handle);
    expect(target.writes).toEqual([]);
  });

  it('coalesces neighboring changes into one run per attribute', () => {
    const { store, target, handle } = filled(50);
    for (const i of [10, 11, 12, 30]) store.setScalar('sizePx', i, 7);
    store.flush(target, handle);
    expect(target.writes.map((w) => [w.first, w.count])).toEqual([
      [10, 3],
      [30, 1],
    ]);
  });

  it('removes by moving the last feature into the hole, growing without a rebuild', () => {
    const { store, target, handle } = filled(20);
    expect(store.remove('f3')).toBe(3);
    expect(store.idAt(3)).toBe('f19');
    expect(store.indexOf('f19')).toBe(3);
    expect(store.count).toBe(19);
    store.flush(target, handle);
    expect(target.state(handle).count).toBe(19);
    expect(target.writes.every((w) => w.first === 3 && w.count === 1)).toBe(true);
    target.clearWrites();
    for (let i = 20; i < 40; i++) store.add(`f${i}`, {});
    store.flush(target, handle);
    expect(target.state(handle).capacity).toBe(store.capacity);
    expect(target.writes.every((w) => w.first >= 19)).toBe(true);
    expect(() => store.add('f1', {})).toThrow(/duplicate/);
  });
});
