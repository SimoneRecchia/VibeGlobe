import type { Globe } from '@vibeglobe/core';
import { createGlobeLayers, DataLayer, type Feature } from '@vibeglobe/layers';

/** Features of the layer: a 400 by 250 grid over central Europe. */
const COLUMNS = 400;
const ROWS = 250;
const COUNT = COLUMNS * ROWS;
/** Updates per second, each a new position and a new color of one feature (F378). */
const UPDATES_PER_SECOND = 10_000;
/** The feed's timer period: the updates due at a tick go out together, as a socket's batch would. */
const TICK_MS = 10;

/**
 * `?scenario=live-feed` (F378): a sensor-style feed on a 100,000-point layer, 10,000 position and color updates a second
 * through the layer's allocation-free paths (`setFeaturePosition`, `setFeatureColor`), from a timer outside the render
 * loop, itself allocating nothing. `window.vibeglobeLiveFeed` counts the updates and stops the feed.
 */
export function showLiveFeed(globe: Globe): void {
  const { stack } = createGlobeLayers(globe);
  const features: Feature[] = Array.from({ length: COUNT }, (_, i) => ({
    type: 'Feature',
    id: i,
    properties: {},
    geometry: { type: 'Point', coordinates: [2 + (i % COLUMNS) * 0.04, 42 + Math.floor(i / COLUMNS) * 0.04] },
  }));
  const layer = stack.add(
    new DataLayer('point', { id: 'live', data: features, style: { 'circle-color': '#20c0ff', 'circle-radius': 2 } }),
  );
  let next = 0;
  let updates = 0;
  let phase = 0;
  const start = performance.now();
  // Each tick applies every update due since the feed started, as a socket delivers what arrived meanwhile: a busy
  // main thread (a slow GPU) delays the timer, not the feed.
  const timer = setInterval(() => {
    phase += 0.01;
    const due = Math.floor(((performance.now() - start) * UPDATES_PER_SECOND) / 1000);
    while (updates < due) {
      const i = next;
      next = (next + 7919) % COUNT;
      const wobble = 0.01 * Math.sin(phase + i);
      layer.setFeaturePosition(i, 2 + (i % COLUMNS) * 0.04 + wobble, 42 + Math.floor(i / COLUMNS) * 0.04 - wobble);
      const level = 0.5 + 0.5 * Math.sin(phase * 3 + i);
      layer.setFeatureColor(i, level, 0.4, 1 - level);
      updates++;
    }
  }, TICK_MS);
  window.vibeglobeLiveFeed = { updates: () => updates, stop: () => clearInterval(timer) };
}

declare global {
  interface Window {
    vibeglobeLiveFeed?: { updates(): number; stop(): void };
  }
}
