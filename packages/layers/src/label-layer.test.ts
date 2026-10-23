import { describe, expect, it } from 'vitest';
import { flatProjector, frameAt, point } from './__fixtures__/test-support.js';
import type { Feature } from './geojson.js';
import { LabelLayer } from './label-layer.js';
import { LabelPlacer, type CollisionBox, type PlacementInput } from './label-placement.js';
import { LayerStack } from './layer-stack.js';
import { estimatedTextMeasurer } from './render-target.js';
import { RecordingRenderTarget } from './testing.js';

/** 10,000 labels of mixed priorities packed into a dense area around Rome. */
function denseLabels(count: number): Feature[] {
  return Array.from({ length: count }, (_, i) =>
    point(i, 12 + ((i * 7919) % 1000) / 100, 41 + ((i * 104_729) % 1000) / 100, { name: `L${i}`, rank: i % 13 }),
  );
}

function overlaps(a: { minX: number; minY: number; maxX: number; maxY: number }, b: typeof a): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

describe('label placement and collision', () => {
  it('shows no overlapping labels and keeps the higher priority one on every collision (F359)', () => {
    const layer = new LabelLayer({
      data: denseLabels(10_000),
      style: { 'text-field': ['get', 'name'], 'symbol-sort-key': ['get', 'rank'] },
    });
    const stack = new LayerStack(new RecordingRenderTarget());
    stack.add(layer);
    stack.frame(frameAt(0, 8, flatProjector(40)));
    const boxes = layer.collisionBoxes;
    const placed = boxes.filter((b) => b.placed);
    expect(placed.length).toBeGreaterThan(50);
    expect(placed.length).toBeLessThan(boxes.length);
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++)
        expect(overlaps(placed[i] as CollisionBox, placed[j] as CollisionBox)).toBe(false);
    }
    const rank = (id: unknown): number => (id as number) % 13;
    for (const hidden of boxes.filter((b) => !b.placed)) {
      const blocker = placed.find((p) => overlaps(p, hidden));
      expect(blocker).toBeDefined();
      expect(rank(blocker?.id)).toBeLessThanOrEqual(rank(hidden.id));
    }
  });

  it('shows hidden labels again as zooming in frees space', () => {
    const layer = new LabelLayer({
      data: denseLabels(2000),
      style: { 'text-field': ['get', 'name'] },
      collision: { placementIntervalMs: 0 },
    });
    const stack = new LayerStack(new RecordingRenderTarget());
    stack.add(layer);
    stack.frame(frameAt(0, 6, flatProjector(20)));
    const before = layer.collisionBoxes.filter((b) => b.placed).length;
    stack.frame(frameAt(16, 9, flatProjector(160)));
    expect(layer.collisionBoxes.filter((b) => b.placed).length).toBeGreaterThan(before * 4);
  });

  it('places the same labels whatever the input order, and hides labels behind the globe', () => {
    const inputs: PlacementInput[] = Array.from({ length: 400 }, (_, i) => ({
      id: `n${i}`,
      longitudeDeg: (i % 40) * 4 - 80 + (i % 3) * 0.3,
      latitudeDeg: Math.floor(i / 40) * 0.5,
      heightMeters: 0,
      text: 'Label',
      sizePx: 14,
      anchor: 0,
      offsetXEm: 0,
      offsetYEm: 0,
      sortKey: i % 5,
      enabled: true,
    }));
    inputs.push({ ...(inputs[0] as PlacementInput), id: 'far', longitudeDeg: 170 });
    const placedIds = (order: PlacementInput[]): string[] => {
      const placer = new LabelPlacer(estimatedTextMeasurer);
      placer.update(0, flatProjector(10), () => order);
      return order
        .filter((l) => placer.isPlaced(l.id))
        .map((l) => String(l.id))
        .sort();
    };
    const forward = placedIds(inputs);
    expect(placedIds([...inputs].reverse())).toEqual(forward);
    expect(forward).not.toContain('far');
  });

  it('fades labels in and out over the fade duration instead of popping, between placement passes (F360)', () => {
    const placer = new LabelPlacer(estimatedTextMeasurer, { fadeDurationMs: 300, placementIntervalMs: 300 });
    const label: PlacementInput = {
      id: 'a',
      longitudeDeg: 0,
      latitudeDeg: 0,
      heightMeters: 0,
      text: 'A',
      sizePx: 16,
      anchor: 0,
      offsetXEm: 0,
      offsetYEm: 0,
      sortKey: 0,
      enabled: true,
    };
    let enabled = true;
    const opacities: number[] = [];
    for (let t = 0; t <= 1200; t += 16) {
      if (t >= 600) enabled = false;
      placer.update(t, flatProjector(), () => [{ ...label, enabled }]);
      opacities.push(placer.opacity('a'));
    }
    const steps = opacities.slice(1).map((o, i) => Math.abs(o - (opacities[i] as number)));
    expect(Math.max(...steps)).toBeLessThanOrEqual(16 / 300 + 1e-9);
    expect(opacities).toContain(1);
    expect(opacities.at(-1)).toBe(0);
    const toggles = opacities.slice(1).filter((o, i) => o > 0 !== (opacities[i] as number) > 0).length;
    expect(toggles).toBe(2);
    expect(placer.passes).toBeLessThanOrEqual(1200 / 300 + 1);
  });

  it('uploads label fade as the visibility factor', () => {
    const target = new RecordingRenderTarget();
    const stack = new LayerStack(target);
    const layer = stack.add(
      new LabelLayer({ data: [point('a', 0, 0, { name: 'A' })], style: { 'text-field': ['get', 'name'] } }),
    );
    stack.frame(frameAt(0, 5));
    stack.frame(frameAt(150, 5));
    expect(target.value({ id: 1 }, 'visible', 0)).toBeCloseTo(0.5);
    expect(target.string({ id: 1 }, 'text', 0)).toBe('A');
    layer.removeFeature('a');
    stack.frame(frameAt(166, 5));
    expect(target.state({ id: 1 }).count).toBe(0);
  });
});
