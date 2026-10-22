import { GlobeError, type Globe } from '@vibeglobe/core';
import { LayerStack } from './layer-stack.js';

/**
 * A layer stack drawn by a globe (ADR 0037): its batches go to the globe's renderer, and every drawn frame advances it
 * with the frame's clock, zoom and projection (styles by zoom, label placement, clusters). Call after `globe.ready`;
 * the stack stops following the globe when the returned `detach` is called or the globe is destroyed.
 */
export function createGlobeLayers(globe: Globe): { stack: LayerStack; detach: () => void } {
  const target = globe.layerTarget();
  if (!target) throw new GlobeError('invalid-option', 'The globe has no layer renderer yet: wait for globe.ready');
  const stack = new LayerStack(target);
  const projector = { geoToScreen: globe.geoToScreen.bind(globe), zoom: () => globe.camera.zoom };
  const detach = globe.on('frame', () => stack.frame({ nowMs: globe.timeMs, zoom: globe.camera.zoom, projector }));
  return { stack, detach };
}
