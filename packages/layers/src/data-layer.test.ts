import { describe, expect, it } from 'vitest';
import { frameAt, point, randomPoints } from './__fixtures__/test-support.js';
import { DataLayer } from './data-layer.js';
import type { Feature } from './geojson.js';
import { LayerStack } from './layer-stack.js';
import { RecordingRenderTarget } from './testing.js';

function setup(layer: DataLayer): { target: RecordingRenderTarget; stack: LayerStack; handle: { id: number } } {
  const target = new RecordingRenderTarget();
  const stack = new LayerStack(target);
  stack.add(layer);
  stack.frame(frameAt(0, 5));
  target.clearWrites();
  return { target, stack, handle: { id: 1 } };
}

describe('data layer', () => {
  it('restyles a feature whose property changed in the next frame, uploading only it (F369, F377)', () => {
    const layer = new DataLayer('point', {
      data: randomPoints(100_000),
      style: {
        'circle-color': ['match', ['get', 'state'], 'alarm', '#ff0000', '#00ff00'],
        'circle-radius': ['get', 'r'],
      },
    });
    const { target, stack, handle } = setup(layer);
    const evaluations = layer.stats.featureEvaluations;
    layer.updateFeature(777, { properties: { state: 'alarm', r: 9 } });
    layer.setFeatureVisible(778, false);
    stack.frame(frameAt(16, 5));
    expect(target.value(handle, 'color', 777, 0)).toBe(1);
    expect(target.value(handle, 'sizePx', 777)).toBe(9);
    expect(target.value(handle, 'visible', 778)).toBe(0);
    expect(layer.stats.featureEvaluations - evaluations).toBe(1);
    expect(target.writes.every((w) => w.count === 1 && (w.first === 777 || w.first === 778))).toBe(true);
  });

  it('moves one feature per frame through in-place position updates (F376)', () => {
    const layer = new DataLayer('point', { data: randomPoints(10_000) });
    const { target, stack, handle } = setup(layer);
    for (let frame = 1; frame <= 10; frame++) {
      layer.setFeaturePosition(5, frame, -frame);
      stack.frame(frameAt(frame * 16, 5));
      expect(target.value(handle, 'position', 5, 0)).toBe(frame);
      expect(target.writes).toEqual([{ batch: 1, attribute: 'position', first: 5, count: 1 }]);
      target.clearWrites();
    }
  });

  it('recolors one feature in place without evaluating its style, for live feeds (F378)', () => {
    const layer = new DataLayer('point', { data: randomPoints(10_000), style: { 'circle-color': '#000000' } });
    const { target, stack, handle } = setup(layer);
    stack.frame(frameAt(16, 5));
    target.clearWrites();
    const evaluations = layer.stats.featureEvaluations;
    expect(layer.setFeatureColor(9, 1, 0.5, 0.25)).toBe(true);
    stack.frame(frameAt(32, 5));
    expect([0, 1, 2, 3].map((c) => target.value(handle, 'color', 9, c))).toEqual([1, 0.5, 0.25, 1]);
    expect(target.writes).toEqual([{ batch: 1, attribute: 'color', first: 9, count: 1 }]);
    expect(layer.stats.featureEvaluations).toBe(evaluations);
    expect(layer.setFeatureColor('missing', 1, 1, 1)).toBe(false);
  });

  it('evaluates zoom-only styles once per frame as layer-wide values (F370)', () => {
    const layer = new DataLayer('point', {
      data: randomPoints(1000),
      style: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 0, 1, 10, 11], 'circle-color': '#ff0000' },
      minZoom: 2,
    });
    const { target, stack, handle } = setup(layer);
    stack.frame(frameAt(16, 7.5));
    expect(target.uniform(handle, 'sizePx')?.[0]).toBeCloseTo(8.5);
    expect([...(target.uniform(handle, 'color') ?? [])]).toEqual([1, 0, 0, 1]);
    expect(target.writes).toEqual([]);
    expect(target.state(handle).visible).toBe(true);
    stack.frame(frameAt(32, 1.5));
    expect(target.state(handle).visible).toBe(false);
  });

  it('applies hover and selection styles through feature state (F379, F381)', () => {
    const layer = new DataLayer('point', {
      data: [point('a', 0, 0), point('b', 1, 1)],
      style: { 'circle-radius': ['case', ['boolean', ['feature-state', 'hover'], false], 10, 4] },
    });
    const { target, stack, handle } = setup(layer);
    layer.setFeatureState('b', { hover: true });
    stack.frame(frameAt(16, 5));
    expect([target.value(handle, 'sizePx', 0), target.value(handle, 'sizePx', 1)]).toEqual([4, 10]);
    layer.setFeatureState('b', { hover: false });
    stack.frame(frameAt(32, 5));
    expect(target.value(handle, 'sizePx', 1)).toBe(4);
  });

  it('shows streamed chunks in the frame after each arrives, without rebuilding (F372)', async () => {
    let release: () => void = () => undefined;
    const chunks = Array.from({ length: 5 }, (_, c) =>
      randomPoints(1000, c + 1).map((f, i) => ({ ...f, id: c * 1000 + i })),
    );
    async function* stream(): AsyncGenerator<readonly Feature[]> {
      for (const chunk of chunks) {
        await new Promise<void>((resolve) => (release = resolve));
        yield chunk;
      }
    }
    const layer = new DataLayer('point', { data: stream() });
    const { target, stack, handle } = setup(layer);
    for (let c = 0; c < chunks.length; c++) {
      await Promise.resolve();
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
      stack.frame(frameAt((c + 1) * 16, 5));
      expect(target.state(handle).count).toBe((c + 1) * 1000);
      expect(target.writes.filter((w) => w.attribute === 'position').every((w) => w.first >= c * 1000)).toBe(true);
      target.clearWrites();
    }
    expect(layer.stats.fullEvaluations).toBe(0);
  });

  it('asks for a frame when shown or hidden, so the change shows without other activity (KB-113)', () => {
    let frames = 0;
    const target = new RecordingRenderTarget();
    const stack = new LayerStack(target, () => frames++);
    const layer = stack.add(new DataLayer('point', { data: [point('a', 9, 45)] }));
    stack.frame(frameAt(0, 5));
    const before = frames;
    layer.setVisible(false);
    expect(frames).toBeGreaterThan(before);
    stack.frame(frameAt(16, 5));
    const asked = frames;
    stack.setVisible(layer.id, true);
    expect(frames).toBeGreaterThan(asked);
  });

  it('places features at an absolute altitude and rejects invalid coordinates', () => {
    const layer = new DataLayer('point', { data: [point('a', 9, 45)], placement: { absoluteAltitudeMeters: 1000 } });
    expect(layer.getPosition('a')?.heightMeters).toBe(1000);
    expect(() => layer.addFeatures([point('b', 0, 95)])).toThrow(TypeError);
  });
});
