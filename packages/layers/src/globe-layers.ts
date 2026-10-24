// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { GlobeError, type Globe, type ScreenPoint } from '@vibeglobe/core';
import type { Project } from './anchors.js';
import { InteractionController } from './interaction.js';

/** How near a feature's anchor a press starts its drag, CSS pixels. */
const DRAG_RADIUS_PX = 16;
import { LayerStack } from './layer-stack.js';

/** What {@link createGlobeLayers} returns. */
export interface GlobeLayers {
  readonly stack: LayerStack;
  /** Feature interaction (hover, click, selection, drag) against what the renderer drew (F379–F382). */
  readonly interaction: InteractionController;
  /** Stops following the globe's frames and the element's pointer events. */
  detach(): void;
}

/** Pointer events of `element` routed to `interaction`, at CSS-pixel positions relative to it. */
function routePointer(element: HTMLElement, interaction: InteractionController, project: Project): () => void {
  const at = (event: PointerEvent): ScreenPoint => {
    const box = element.getBoundingClientRect();
    return { xPx: event.clientX - box.left, yPx: event.clientY - box.top };
  };
  const move = (event: PointerEvent): void => void interaction.pointerMove(at(event));
  const down = (event: PointerEvent): void => {
    const point = at(event);
    // A press on a draggable feature never reaches the map's controls, so the map does not pan meanwhile (F382).
    if (interaction.pressesDraggable(point, DRAG_RADIUS_PX, project)) {
      event.stopImmediatePropagation();
      event.preventDefault();
      element.setPointerCapture?.(event.pointerId);
    }
    void interaction.pointerDown(point);
  };
  const up = (event: PointerEvent): void => void interaction.pointerUp(at(event));
  const leave = (event: PointerEvent): void => interaction.pointerLeave(at(event));
  element.addEventListener('pointermove', move);
  // In the capture phase: before the controls' own listener on the same element.
  element.addEventListener('pointerdown', down, { capture: true });
  element.addEventListener('pointerup', up);
  element.addEventListener('pointerleave', leave);
  return () => {
    element.removeEventListener('pointermove', move);
    element.removeEventListener('pointerdown', down, { capture: true });
    element.removeEventListener('pointerup', up);
    element.removeEventListener('pointerleave', leave);
  };
}

/**
 * A layer stack drawn by a globe (ADR 0037): its batches go to the globe's renderer, and every drawn frame advances it
 * with the frame's clock, zoom and projection (styles by zoom, label placement, clusters). With `element` (the
 * globe's container or canvas), its pointer events drive feature interaction. Call after `globe.ready`.
 */
export function createGlobeLayers(globe: Globe, options: { readonly element?: HTMLElement } = {}): GlobeLayers {
  const target = globe.layerTarget();
  if (!target) throw new GlobeError('invalid-option', 'The globe has no layer renderer yet: wait for globe.ready');
  const element = options.element;
  // The zoom of the last frame drawn, from the frame event (no camera state object a frame, F378); a change between
  // frames is flushed at it, and the next frame steps at its own.
  const frameZoom = Float64Array.of(globe.camera.zoom);
  const projector = {
    geoToScreen: globe.geoToScreen.bind(globe),
    zoom: () => frameZoom[0] ?? 0,
    ...(element ? { viewportPx: () => ({ widthPx: element.clientWidth, heightPx: element.clientHeight }) } : {}),
  };
  let inFrame = false;
  let detached = false;
  let flushQueued = false;
  // A change outside a frame (data streamed in, a style set) is written to the renderer before the next frame, so
  // that frame shows it (F372); changes during a frame's step are drawn by the frame they ask for.
  // A layer asking for a frame from this step (labels fading, KB-135) gets the next frame, not another flush: the
  // clock does not advance between microtasks, so flushing again would never end.
  const flush = (): void => {
    flushQueued = false;
    if (detached || inFrame) return;
    step();
  };
  const step = (event?: { readonly zoom: number }): void => {
    inFrame = true;
    if (event) frameZoom[0] = event.zoom;
    try {
      stack.frame({ nowMs: globe.timeMs, zoom: frameZoom[0] ?? 0, projector });
    } finally {
      inFrame = false;
    }
  };
  const stack = new LayerStack(target, () => {
    if (!inFrame && !flushQueued) {
      flushQueued = true;
      queueMicrotask(flush);
    }
    globe.requestRender();
  });
  const interaction = new InteractionController(stack, {
    pick: (point) => target.pick?.(point) ?? Promise.resolve(0),
    screenToGeo: (point) => globe.screenToGeo(point),
  });
  const offFrame = globe.on('frame', step);
  const offPointer = options.element
    ? routePointer(options.element, interaction, (position, onGround) =>
        globe.geoToScreen(
          onGround ? { ...position, heightMeters: globe.elevationAt(position).heightMeters } : position,
        ),
      )
    : () => undefined;
  return {
    stack,
    interaction,
    detach: () => {
      detached = true;
      offFrame();
      offPointer();
    },
  };
}
