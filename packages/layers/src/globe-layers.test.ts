import type { Globe } from '@vibeglobe/core';
import { describe, expect, it } from 'vitest';
import { createGlobeLayers } from './globe-layers.js';
import type { Layer, LayerContext } from './layer.js';
import { RecordingRenderTarget } from './testing.js';

/** The part of a globe the layer stack uses, with its frame listeners and render requests counted. */
function stubGlobe(): { globe: Globe; frame: () => void; renders: () => number } {
  const target = new RecordingRenderTarget();
  const frameListeners: (() => void)[] = [];
  let renders = 0;
  const globe = {
    layerTarget: () => target,
    geoToScreen: () => undefined,
    screenToGeo: () => undefined,
    camera: { zoom: 5 },
    timeMs: 0,
    requestRender: () => void renders++,
    on: (_event: string, listener: () => void) => {
      frameListeners.push(listener);
      return () => undefined;
    },
  } as unknown as Globe;
  return { globe, frame: () => frameListeners.forEach((listener) => listener()), renders: () => renders };
}

/** A layer that asks for another frame from every step, as a label layer does while its labels fade. */
class AnimatingLayer implements Layer {
  readonly id = 'animating';
  steps = 0;
  private context: LayerContext | undefined;
  attach(context: LayerContext): void {
    this.context = context;
    context.requestFrame();
  }
  detach(): void {}
  setOrder(): void {}
  setVisible(): void {}
  frame(): void {
    this.steps++;
    this.context?.requestFrame();
  }
}

describe('createGlobeLayers', () => {
  it('a layer asking for a frame from the step outside a frame gets the next frame, not an endless microtask loop (KB-135)', async () => {
    const { globe, frame, renders } = stubGlobe();
    const { stack } = createGlobeLayers(globe);
    const layer = new AnimatingLayer();
    stack.add(layer);
    // Microtasks run until the queue is empty: an endless chain would never reach the timer.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(layer.steps).toBe(1);
    expect(renders()).toBeGreaterThan(0);
    frame();
    expect(layer.steps).toBe(2);
  });
});
