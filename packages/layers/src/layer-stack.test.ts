import { describe, expect, it } from 'vitest';
import { point, frameAt } from './__fixtures__/test-support.js';
import { DataLayer } from './data-layer.js';
import { LayerStack } from './layer-stack.js';
import { ORDER_STRIDE } from './layer.js';
import { packPickId } from './picking.js';
import { RecordingRenderTarget } from './render-target.js';

const layer = (id: string): DataLayer =>
  new DataLayer('point', { id, data: [point(`${id}-a`, 1, 2), point(`${id}-b`, 3, 4)] });

describe('layer stack', () => {
  it('adds, reorders, shows and hides layers, applied on the next frame', () => {
    const target = new RecordingRenderTarget();
    const stack = new LayerStack(target);
    const [a, b, c] = [layer('a'), layer('b'), layer('c')];
    stack.add(a);
    stack.add(b);
    stack.add(c, { below: 'a' });
    expect(stack.order).toEqual(['c', 'a', 'b']);
    stack.move('b', { index: 0 });
    stack.move('c', { above: 'a' });
    expect(stack.order).toEqual(['b', 'a', 'c']);
    expect(() => stack.move('c', { above: 'missing' })).toThrow(/missing/);
    expect(stack.order).toEqual(['b', 'a', 'c']);
    expect(() => stack.add(layer('a'))).toThrow(/already/);
    stack.setVisible('a', false);
    stack.frame(frameAt(0, 5));
    const handles = [1, 2, 3].map((id) => ({ id }));
    const states = handles.map((h) => target.state(h));
    expect(states.map((s) => s.order)).toEqual([1, 0, 2].map((o) => o * ORDER_STRIDE));
    expect(states.map((s) => s.visible)).toEqual([false, true, true]);
    expect(states.map((s) => s.count)).toEqual([2, 2, 2]);
    stack.setVisible('a', true);
    stack.frame(frameAt(16, 5));
    expect(target.state({ id: 1 }).visible).toBe(true);
    expect(stack.isVisible('a')).toBe(true);
  });

  it('resolves picked ids to the layer and feature, and frees everything on removal (F385)', () => {
    const target = new RecordingRenderTarget();
    const stack = new LayerStack(target);
    for (let cycle = 0; cycle < 100; cycle++) {
      const a = stack.add(layer('a'));
      a.on('click', () => undefined);
      stack.frame(frameAt(cycle, 5));
      const pickId = target.value({ id: target.created }, 'pickId', 1) as number;
      expect(stack.resolvePick(pickId)?.feature.id).toBe('a-b');
      stack.remove('a');
      expect(a.listenerCount).toBe(0);
      expect(stack.resolvePick(pickId)).toBeUndefined();
    }
    expect(target.liveBatches).toBe(0);
    expect(target.created).toBe(target.released);
    expect(stack.resolvePick(0)).toBeUndefined();
    expect(stack.resolvePick(packPickId(200, 0))).toBeUndefined();
  });
});
