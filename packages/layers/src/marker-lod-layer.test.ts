import { describe, expect, it } from 'vitest';
import { frameAt, point } from './__fixtures__/test-support.js';
import { LayerStack } from './layer-stack.js';
import { MarkerLodLayer } from './marker-lod-layer.js';
import { RecordingRenderTarget } from './testing.js';

describe('marker level of detail (F374)', () => {
  it('shows a marker standing alone in full and dense ones as dots, switching by a cross-fade', () => {
    // A flat projection at 10 px per degree: the lone marker has its 48 px bin to itself, the ten others share one.
    const cluster = Array.from({ length: 10 }, (_, i) => point(`c${String(i)}`, 20 + i * 0.01, 0));
    const layer = new MarkerLodLayer({ data: [point('alone', 0, 0), ...cluster], lod: { fadeMs: 200 } });
    const target = new RecordingRenderTarget();
    const stack = new LayerStack(target);
    stack.add(layer);
    const dots = { id: 1 };
    const markers = { id: 2 };
    stack.frame(frameAt(0, 5));
    expect(layer.lodStats).toEqual({ full: 0, simplified: 10, fading: 1 });
    // Halfway through the fade both representations of the lone marker show at half strength.
    stack.frame(frameAt(100, 5));
    expect(target.value(markers, 'visible', 0)).toBeCloseTo(0.5);
    expect(target.value(dots, 'visible', 0)).toBeCloseTo(0.5);
    stack.frame(frameAt(200, 5));
    expect(target.value(markers, 'visible', 0)).toBe(1);
    expect(target.value(dots, 'visible', 0)).toBe(0);
    expect(target.value(markers, 'visible', 5)).toBe(0);
    expect(target.value(dots, 'visible', 5)).toBe(1);
    expect(layer.lodStats).toEqual({ full: 1, simplified: 10, fading: 0 });
    expect(layer.isFull('alone')).toBe(true);
    // Zoomed in (10,000 px per degree here, the cluster 100 px apart), the cluster spreads over its own bins: its markers fade in where alone.
    stack.frame(
      frameAt(300, 7, { geoToScreen: (p) => ({ xPx: p.longitudeDeg * 10_000 - 199_000, yPx: 0 }), zoom: () => 7 }),
    );
    stack.frame(
      frameAt(600, 7, { geoToScreen: (p) => ({ xPx: p.longitudeDeg * 10_000 - 199_000, yPx: 0 }), zoom: () => 7 }),
    );
    expect(layer.lodStats.full).toBeGreaterThan(1);
    // Hidden features stay hidden in both representations.
    layer.setFeatureVisible('alone', false);
    stack.frame(frameAt(700, 7));
    expect(target.value(markers, 'visible', 0)).toBe(0);
    expect(target.value(dots, 'visible', 0)).toBe(0);
  });
});
