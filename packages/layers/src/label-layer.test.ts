import { describe, expect, it } from 'vitest';
import { flatProjector, frameAt, point } from './__fixtures__/test-support.js';
import type { Feature } from './geojson.js';
import { LabelLayer } from './label-layer.js';
import { LabelPlacer, type CollisionBox, type PlacementInput } from './label-placement.js';
import type { FrameContext } from './layer.js';
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

/** Draws frames 16 ms apart from `t0` until the layer's next placement pass ends (a pass is sliced across frames). */
function framesUntilPlaced(
  stack: LayerStack,
  layer: LabelLayer,
  t0: number,
  frame: (t: number) => FrameContext,
): number {
  const passes = layer.placer.passes;
  let t = t0;
  for (; layer.placer.passes === passes; t += 16) stack.frame(frame(t));
  return t;
}

describe('label placement and collision', () => {
  it('shows no overlapping labels and keeps the higher priority one on every collision (F359)', () => {
    const layer = new LabelLayer({
      data: denseLabels(10_000),
      style: { 'text-field': ['get', 'name'], 'symbol-sort-key': ['get', 'rank'] },
    });
    const stack = new LayerStack(new RecordingRenderTarget());
    stack.add(layer);
    framesUntilPlaced(stack, layer, 0, (t) => frameAt(t, 8, flatProjector(40)));
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
    const t = framesUntilPlaced(stack, layer, 0, (t) => frameAt(t, 6, flatProjector(20)));
    const before = layer.collisionBoxes.filter((b) => b.placed).length;
    framesUntilPlaced(stack, layer, t, (t) => frameAt(t, 9, flatProjector(160)));
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
      for (let t = 0; placer.passes === 0; t += 16) placer.update(t, flatProjector(10), () => order);
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

  it('asks for no more frames once placed and faded while the view stands still, and again when it moves (F359)', () => {
    const placer = new LabelPlacer(estimatedTextMeasurer, { fadeDurationMs: 100, placementIntervalMs: 100 });
    const labels = (): PlacementInput[] => [
      {
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
      },
    ];
    let t = 0;
    for (; placer.pending && t < 2000; t += 16) placer.update(t, flatProjector(10), labels);
    expect(placer.opacity('a')).toBe(1);
    // A frame drawn for another reason (an upload, a tile) asks for at most the frames of one sliced pass: the engine,
    // which draws only frames asked for, goes idle.
    for (let external = 0; external < 3; external++) {
      t += 200;
      placer.update(t, flatProjector(10), labels);
      let requested = 0;
      for (; placer.pending && requested < 10; requested++) placer.update((t += 16), flatProjector(10), labels);
      expect(requested).toBeLessThanOrEqual(2);
    }
    // A zoom changes the view: placement is due again.
    placer.update(t, flatProjector(11), labels);
    expect(placer.pending).toBe(true);
  });

  it('keeps no per-label objects of its own from pass to pass: the boxes of the pass before last are reused (KB-171)', () => {
    // Objects a sliced pass keeps across frames are copied by every young-generation collection, inside the slices.
    const placer = new LabelPlacer(estimatedTextMeasurer, { placementIntervalMs: 0 });
    const labels = (): PlacementInput[] =>
      Array.from({ length: 50 }, (_, i) => ({
        id: i,
        longitudeDeg: i * 3,
        latitudeDeg: 0,
        heightMeters: 0,
        text: `L${i}`,
        sizePx: 12,
        anchor: 0,
        offsetXEm: 0,
        offsetYEm: 0,
        sortKey: 0,
        enabled: true,
      }));
    const pass = (zoom: number): readonly CollisionBox[] => {
      const passes = placer.passes;
      for (let t = 0; placer.passes === passes; t += 16) placer.update(t + zoom * 1000, flatProjector(zoom), labels);
      return placer.collisionBoxes;
    };
    const first = [...pass(10)];
    pass(11);
    const third = pass(12);
    expect(third.length).toBe(first.length);
    expect(third.every((box, i) => box === first[i])).toBe(true);
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

  it('asks for frames until placement catches up with a view change, then stops (KB-117, F359)', () => {
    const layer = new LabelLayer({ data: denseLabels(10_000), style: { 'text-field': ['get', 'name'] } });
    let requests = 0;
    const stack = new LayerStack(new RecordingRenderTarget(), () => requests++);
    stack.add(layer);
    // The host draws one frame, then only the frames the layers ask for (a globe draws only when asked).
    let now = 0;
    for (const zoom of [8, 9]) {
      const passes = layer.placer.passes;
      requests = 0;
      stack.frame(frameAt((now += 16), zoom, flatProjector(zoom * 20)));
      for (let frames = 0; frames < 1000 && requests > 0; frames++) {
        requests = 0;
        stack.frame(frameAt((now += 16), zoom, flatProjector(zoom * 20)));
      }
      expect(layer.placer.passes, `zoom ${zoom}`).toBeGreaterThan(passes);
      expect(requests, `zoom ${zoom}: settled`).toBe(0);
    }
  });
});
