import type { Globe } from '@vibeglobe/core';
import { createGlobeLayers, DataLayer, type Feature } from '@vibeglobe/layers';

/**
 * `?scenario=data-stream` (F372): an application streaming 100,000 points in chunks of 1,000 into one layer that
 * reserved room for them. `window.vibeglobeStream.add(k)` adds chunk k (a 25 by 40 grid in its own 0.3° cell of a 10 by
 * 10 block south-west of Rome) and returns the position of its first point.
 */
export function showStream(globe: Globe): void {
  const { stack } = createGlobeLayers(globe);
  const layer = stack.add(
    new DataLayer('point', {
      id: 'stream',
      capacity: Number(new URLSearchParams(location.search).get('capacity') ?? 100_000),
      data: [],
      style: { 'circle-color': '#ff2020', 'circle-radius': 2 },
    }),
  );
  window.vibeglobeStream = {
    add(chunk: number): [number, number] {
      const west = 10 + (chunk % 10) * 0.3;
      const south = 40 + Math.floor(chunk / 10) * 0.3;
      const features: Feature[] = Array.from({ length: 1000 }, (_, i) => ({
        type: 'Feature',
        id: `s${String(chunk)}-${String(i)}`,
        properties: {},
        geometry: { type: 'Point', coordinates: [west + (i % 40) * 0.006, south + Math.floor(i / 40) * 0.009] },
      }));
      layer.addFeatures(features);
      return [west, south];
    },
    count: () => layer.featureCount,
  };
}

declare global {
  interface Window {
    vibeglobeStream?: { add(chunk: number): [number, number]; count(): number };
  }
}
