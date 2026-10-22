import type { Globe } from '@vibeglobe/core';
import { createGlobeLayers, DataLayer, type LayerStack } from '@vibeglobe/layers';

declare global {
  interface Window {
    /** The `?layers=demo` stack and its layers, for the end-to-end tests of M10. */
    vibeglobeLayers?: { stack: LayerStack; layers: Record<string, DataLayer> };
  }
}

/** A closed ring of a rectangle in degrees, counterclockwise. */
function rectangle(west: number, south: number, east: number, north: number): number[][] {
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
}

/**
 * `?layers=demo` (M10, ADR 0037): points, a line, a polygon with a hole and an extruded polygon around Rome, drawn by
 * the renderer through the layers package's public API.
 */
export function showLayersDemo(globe: Globe): void {
  const { stack } = createGlobeLayers(globe);
  const points = stack.add(
    new DataLayer('point', {
      id: 'points',
      data: [
        { type: 'Feature', id: 'a', properties: {}, geometry: { type: 'Point', coordinates: [12.45, 41.9] } },
        { type: 'Feature', id: 'b', properties: {}, geometry: { type: 'Point', coordinates: [12.55, 41.9] } },
      ],
      style: { 'circle-color': '#ff2020', 'circle-radius': 10 },
    }),
  );
  const line = stack.add(
    new DataLayer('polyline', {
      id: 'line',
      data: [
        {
          type: 'Feature',
          id: 'l',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: [
              [12.4, 41.85],
              [12.6, 41.95],
            ],
          },
        },
      ],
      style: { 'line-color': '#2050ff', 'line-width': 6 },
    }),
  );
  const polygon = stack.add(
    new DataLayer('polygon', {
      id: 'polygon',
      data: [
        {
          type: 'Feature',
          id: 'p',
          properties: {},
          geometry: {
            type: 'Polygon',
            coordinates: [rectangle(12.4, 41.8, 12.6, 41.85), rectangle(12.48, 41.81, 12.52, 41.84)],
          },
        },
      ],
      style: { 'fill-color': '#20c040', 'fill-opacity': 0.8 },
    }),
  );
  window.vibeglobeLayers = { stack, layers: { points, line, polygon } };
}
