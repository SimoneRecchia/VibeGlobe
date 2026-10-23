import type { GeoPosition, ScreenPoint } from '@vibeglobe/core';
import { describe, expect, it } from 'vitest';
import { frameAt, point } from './__fixtures__/test-support.js';
import { DataLayer } from './data-layer.js';
import { InteractionController, type PickProvider } from './interaction.js';
import { LayerStack } from './layer-stack.js';
import { RecordingRenderTarget } from './testing.js';

/** A pick provider over a recorded target: a screen point `{ xPx: n }` hits feature index n of batch 1 (n < 0: none). */
function provider(target: RecordingRenderTarget, delays: number[] = []): PickProvider {
  return {
    async pick(p: ScreenPoint) {
      const delay = delays.shift() ?? 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      return p.xPx < 0 ? 0 : (target.value({ id: 1 }, 'pickId', p.xPx) ?? 0);
    },
    screenToGeo: (p: ScreenPoint): GeoPosition => ({
      longitudeDeg: p.xPx / 10,
      latitudeDeg: p.yPx / 10,
      heightMeters: 12,
    }),
  };
}

function setup(draggable = false): {
  layer: DataLayer;
  stack: LayerStack;
  target: RecordingRenderTarget;
  log: string[];
} {
  const target = new RecordingRenderTarget();
  const stack = new LayerStack(target);
  const layer = stack.add(
    new DataLayer('point', {
      data: [point('a', 0, 0), point('b', 1, 1)],
      draggable,
      style: { 'circle-radius': ['case', ['boolean', ['feature-state', 'hover'], false], 9, 4] },
    }),
  );
  stack.frame(frameAt(0, 5));
  const log: string[] = [];
  for (const type of ['hover-enter', 'hover-leave', 'click', 'drag-start', 'drag', 'drag-end'] as const) {
    layer.on(type, (e) => log.push(`${type}:${String(e.feature.id)}:${e.position?.longitudeDeg ?? '-'}`));
  }
  return { layer, stack, target, log };
}

describe('feature interaction', () => {
  it('emits hover enter and leave once each, in order, and applies the hover style (F379)', async () => {
    const { stack, target, log } = setup();
    const controller = new InteractionController(stack, provider(target));
    for (const x of [0, 0, 1, 1, -1, -1]) await controller.pointerMove({ xPx: x, yPx: 0 });
    expect(log).toEqual(['hover-enter:a:0', 'hover-leave:a:0.1', 'hover-enter:b:0.1', 'hover-leave:b:-0.1']);
    await controller.pointerMove({ xPx: 1, yPx: 0 });
    stack.frame(frameAt(16, 5));
    expect(target.value({ id: 1 }, 'sizePx', 1)).toBe(9);
    controller.pointerLeave({ xPx: 1, yPx: 0 });
    stack.frame(frameAt(32, 5));
    expect(target.value({ id: 1 }, 'sizePx', 1)).toBe(4);
  });

  it('drops a pick answered after a newer one, so events follow the latest pointer position', async () => {
    const { stack, target, log } = setup();
    const controller = new InteractionController(stack, provider(target, [30, 0]));
    await Promise.all([controller.pointerMove({ xPx: 0, yPx: 0 }), controller.pointerMove({ xPx: 1, yPx: 0 })]);
    expect(log).toEqual(['hover-enter:b:0.1']);
  });

  it('clicks when the release comes before the press has picked, as in a quick tap (KB-111)', async () => {
    const { stack, target, log } = setup();
    // The press's pick answers after the release's.
    const controller = new InteractionController(stack, provider(target, [0, 30, 0]));
    const move = controller.pointerMove({ xPx: 1, yPx: 0 });
    const down = controller.pointerDown({ xPx: 1, yPx: 0 });
    const up = controller.pointerUp({ xPx: 1, yPx: 0 });
    await Promise.all([move, down, up]);
    expect(log.filter((e) => e.startsWith('click'))).toEqual(['click:b:0.1']);
  });

  it('clicks with the feature, layer and position, and selects through feature state (F380, F381)', async () => {
    const { layer, stack, target, log } = setup();
    const controller = new InteractionController(stack, provider(target));
    expect(await controller.pointerDown({ xPx: 1, yPx: 20 })).toBe(false);
    await controller.pointerUp({ xPx: 1, yPx: 20 });
    expect(log).toEqual(['click:b:0.1']);
    expect(controller.select(layer.id, 'b')).toBe(true);
    expect(layer.getFeatureState('b')).toEqual({ selected: true });
    controller.clearSelection();
    expect(layer.getFeatureState('b')).toEqual({ selected: false });
  });

  it('drags only draggable features, with start, move and end events, and keeps the map from panning (F382)', async () => {
    const fixed = setup(false);
    const fixedController = new InteractionController(fixed.stack, provider(fixed.target));
    expect(await fixedController.pointerDown({ xPx: 0, yPx: 0 })).toBe(false);
    await fixedController.pointerMove({ xPx: 30, yPx: 40 });
    expect(fixed.layer.getPosition('a')?.longitudeDeg).toBe(0);

    const { layer, stack, target, log } = setup(true);
    const controller = new InteractionController(stack, provider(target));
    expect(await controller.pointerDown({ xPx: 0, yPx: 0 })).toBe(true);
    await controller.pointerMove({ xPx: 30, yPx: 40 });
    expect(controller.dragging).toBe(true);
    await controller.pointerMove({ xPx: 50, yPx: 60 });
    await controller.pointerUp({ xPx: 50, yPx: 60 });
    expect(log).toEqual(['drag-start:a:3', 'drag:a:3', 'drag:a:5', 'drag-end:a:5']);
    // A ground-clamped point keeps its height above the ground: the terrain's height under the pointer is not added
    // to it (KB-129).
    expect(layer.getPosition('a')).toEqual({ longitudeDeg: 5, latitudeDeg: 6, heightMeters: 0 });
    expect(controller.dragging).toBe(false);
  });

  it('tells at once whether a press lands on a draggable feature, before the asynchronous pick (F382)', () => {
    // Positions show at 100 px per degree.
    const project = (p: GeoPosition): ScreenPoint => ({
      xPx: p.longitudeDeg * 100,
      yPx: p.latitudeDeg * 100,
    });
    for (const draggable of [true, false]) {
      const { stack, target } = setup(draggable);
      const controller = new InteractionController(stack, provider(target));
      expect(controller.pressesDraggable({ xPx: 105, yPx: 95 }, 16, project)).toBe(draggable);
      expect(controller.pressesDraggable({ xPx: 50, yPx: 50 }, 16, project)).toBe(false);
    }
  });
});
