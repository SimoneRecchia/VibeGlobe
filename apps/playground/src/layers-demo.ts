import type { Globe } from '@vibeglobe/core';
import {
  createGlobeLayers,
  DataLayer,
  type InteractionController,
  type Feature,
  type Geometry,
  type LayerStack,
} from '@vibeglobe/layers';

declare global {
  interface Window {
    /** The `?layers=demo` stack and its layers, for the end-to-end tests of M10. */
    vibeglobeLayers?: { stack: LayerStack; layers: Record<string, DataLayer>; interaction?: InteractionController };
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

function feature(id: string, geometry: Geometry, properties: Record<string, unknown> = {}): Feature {
  return { type: 'Feature', id, properties, geometry };
}

/** 1,000 points on a golden-angle spiral over the whole globe, deterministic, and a grid around Rome (F351). */
function worldPoints(): Feature[] {
  const points: Feature[] = [];
  for (let i = 0; i < 1000; i++) {
    const lat = (Math.asin(-1 + (2 * (i + 0.5)) / 1000) * 180) / Math.PI;
    const lon = ((((i * 137.50776405) % 360) + 540) % 360) - 180;
    points.push(feature(`p${String(i)}`, { type: 'Point', coordinates: [lon, lat] }, { r: 3 + (i % 3) }));
  }
  // And a 10 × 10 grid around Rome, 0.6° apart, for the flat and tilted views at city to region scale.
  for (let i = 0; i < 100; i++)
    points.push(
      feature(
        `g${String(i)}`,
        { type: 'Point', coordinates: [9.8 + (i % 10) * 0.6, 39.2 + Math.floor(i / 10) * 0.6] },
        { r: 4 },
      ),
    );
  return points;
}

/** The data layers' test scenes (F351, F353, F354), by scenario name. */
const DATA_SCENES: Record<string, () => DataLayer> = {
  'data-points': () =>
    new DataLayer('point', {
      id: 'points',
      data: worldPoints(),
      style: { 'circle-color': '#ff2020', 'circle-radius': ['get', 'r'] },
    }),
  'data-lines': () =>
    new DataLayer('polyline', {
      id: 'lines',
      data: [
        // Short, intercontinental (Rome to New York) and across the antimeridian, at widths 2, 4 and 8.
        feature(
          'short',
          {
            type: 'LineString',
            coordinates: [
              [12.4, 41.8],
              [12.6, 42.0],
            ],
          },
          { w: 2 },
        ),
        feature(
          'atlantic',
          {
            type: 'LineString',
            coordinates: [
              [12.5, 41.9],
              [-74, 40.7],
            ],
          },
          { w: 4 },
        ),
        feature(
          'pacific',
          {
            type: 'LineString',
            coordinates: [
              [170, -10],
              [-170, 10],
            ],
          },
          { w: 8 },
        ),
      ],
      style: { 'line-color': '#2050ff', 'line-width': ['get', 'w'] },
    }),
  'data-polygons': () =>
    new DataLayer('polygon', {
      id: 'polygons',
      data: [
        feature('small', { type: 'Polygon', coordinates: [rectangle(12.4, 41.8, 12.6, 42.0)] }),
        feature('holed', { type: 'Polygon', coordinates: [rectangle(0, 40, 10, 50), rectangle(3, 43, 7, 47)] }),
        // About the size of Australia.
        feature('continent', { type: 'Polygon', coordinates: [rectangle(113, -39, 154, -11)] }),
      ],
      style: { 'fill-color': '#20c040', 'fill-opacity': 0.9 },
    }),
  // Latin with accents, Greek, Cyrillic and CJK, at several sizes, colors and anchors (F357).
  'data-labels': () =>
    new DataLayer('label', {
      id: 'labels',
      data: [
        feature(
          'roma',
          { type: 'Point', coordinates: [12.5, 41.9] },
          { t: 'Roma – Città', s: 20, c: '#ffd000', a: 'center' },
        ),
        feature('athens', { type: 'Point', coordinates: [23.7, 38.0] }, { t: 'Αθήνα', s: 16, c: '#40e0ff', a: 'left' }),
        feature(
          'moscow',
          { type: 'Point', coordinates: [37.6, 55.75] },
          { t: 'Москва', s: 24, c: '#ff60ff', a: 'bottom' },
        ),
        feature('tokyo', { type: 'Point', coordinates: [139.7, 35.7] }, { t: '東京', s: 18, c: '#ffffff', a: 'top' }),
      ],
      style: {
        'text-field': ['get', 't'],
        'text-size': ['get', 's'],
        'text-color': ['get', 'c'],
        'text-anchor': ['get', 'a'],
      },
    }),
  // Images with several anchors, sizes and rotations (F352).
  'data-markers': () =>
    new DataLayer('marker', {
      id: 'markers',
      data: [
        feature('m1', { type: 'Point', coordinates: [12.5, 41.9] }, { i: 'pin', a: 'bottom', r: 0 }),
        feature('m2', { type: 'Point', coordinates: [14.25, 40.85] }, { i: 'square', a: 'center', r: 45 }),
      ],
      style: { 'icon-image': ['get', 'i'], 'icon-anchor': ['get', 'a'], 'icon-rotate': ['get', 'r'], 'icon-size': 32 },
    }),
};

/** The marker images of `data-markers`: a red pin and a blue square, drawn on canvases. */
function markerImages(): Record<string, HTMLCanvasElement> {
  const pin = document.createElement('canvas');
  pin.width = 24;
  pin.height = 32;
  const p = pin.getContext('2d');
  if (p) {
    p.fillStyle = '#e02020';
    p.beginPath();
    p.arc(12, 11, 10, 0, 2 * Math.PI);
    p.fill();
    p.beginPath();
    p.moveTo(4, 16);
    p.lineTo(12, 32);
    p.lineTo(20, 16);
    p.fill();
  }
  const square = document.createElement('canvas');
  square.width = 32;
  square.height = 32;
  const q = square.getContext('2d');
  if (q) {
    q.fillStyle = '#2040e0';
    q.fillRect(0, 0, 32, 32);
  }
  return { pin, square };
}

/**
 * `?scenario=data-points`, `data-lines` and `data-polygons` (F351, F353, F354): the data layers' test scenes, drawn
 * through the layers package's public API.
 */
export function showDataScenario(globe: Globe, name: string): void {
  const element = document.querySelector<HTMLElement>('#globe') ?? undefined;
  const { stack, interaction } = createGlobeLayers(globe, element ? { element } : {});
  if (name === 'data-markers')
    for (const [image, source] of Object.entries(markerImages())) globe.layerTarget()?.addImage?.(image, source);
  const scene = DATA_SCENES[name];
  const layer = scene && stack.add(scene());
  window.vibeglobeLayers = { stack, layers: layer ? { [layer.id]: layer } : {}, interaction };
}
