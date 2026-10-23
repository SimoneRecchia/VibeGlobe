import { DataLayer, type Feature, type Geometry } from '@vibeglobe/layers';

function feature(id: string, geometry: Geometry, properties: Record<string, unknown>): Feature {
  return { type: 'Feature', id, properties, geometry };
}

const point = (lon: number, lat: number): Geometry => ({ type: 'Point', coordinates: [lon, lat] });

/**
 * `?scenario=data-styled` (F369): features around Rome whose color, size, width, opacity, icon and text come from
 * their numeric and categorical properties through expressions. Seen in 2D at zoom 7 centered on (12.5°, 41.7°).
 */
export function styledLayers(): DataLayer[] {
  return [
    new DataLayer('point', {
      id: 'styled-points',
      data: [
        feature('s1', point(12.0, 42.3), { kind: 'hot', pop: 10, op: 100 }),
        feature('s2', point(12.6, 42.3), { kind: 'cold', pop: 30, op: 100 }),
        feature('s3', point(13.2, 42.3), { kind: 'hot', pop: 10, op: 40 }),
      ],
      style: {
        'circle-color': ['match', ['get', 'kind'], 'hot', '#ff2020', 'cold', '#2040ff', '#808080'],
        'circle-radius': ['/', ['get', 'pop'], 2],
        'circle-opacity': ['/', ['get', 'op'], 100],
      },
    }),
    new DataLayer('polyline', {
      id: 'styled-lines',
      data: [
        feature(
          'thin',
          {
            type: 'LineString',
            coordinates: [
              [11.8, 41.7],
              [12.4, 41.7],
            ],
          },
          { w: 2 },
        ),
        feature(
          'wide',
          {
            type: 'LineString',
            coordinates: [
              [12.8, 41.7],
              [13.4, 41.7],
            ],
          },
          { w: 10 },
        ),
      ],
      style: { 'line-color': '#20c040', 'line-width': ['get', 'w'] },
    }),
    new DataLayer('marker', {
      id: 'styled-markers',
      data: [feature('m1', point(12.0, 41.1), { shape: 'pin' }), feature('m2', point(12.6, 41.1), { shape: 'square' })],
      style: { 'icon-image': ['get', 'shape'], 'icon-size': 24 },
    }),
    new DataLayer('label', {
      id: 'styled-labels',
      data: [feature('t1', point(13.2, 41.1), { name: 'Roma' })],
      style: { 'text-field': ['upcase', ['get', 'name']], 'text-size': 20, 'text-color': '#ffd000' },
    }),
  ];
}

/**
 * `?scenario=data-zoom` (F370): a point whose radius, a point whose opacity and a line whose width interpolate with
 * zoom (zoom 6 to 10), and a point shown only from zoom 8 (a step), around (12.5°, 41.9°).
 */
export function zoomLayers(): DataLayer[] {
  const zoomed = (low: number, high: number) => ['interpolate', ['linear'], ['zoom'], 6, low, 10, high];
  return [
    new DataLayer('polyline', {
      id: 'zoom-line',
      data: [
        feature(
          'line',
          {
            type: 'LineString',
            coordinates: [
              [12.3, 41.88],
              [12.7, 41.88],
            ],
          },
          {},
        ),
      ],
      style: { 'line-color': '#20c040', 'line-width': zoomed(2, 12) },
    }),
    new DataLayer('point', {
      id: 'zoom-point',
      data: [feature('dot', point(12.5, 41.9), {})],
      style: { 'circle-color': '#ff2020', 'circle-radius': zoomed(3, 15) },
    }),
    new DataLayer('point', {
      id: 'zoom-fade',
      data: [feature('fade', point(12.56, 41.9), {})],
      style: { 'circle-color': '#ff2020', 'circle-radius': 6, 'circle-opacity': zoomed(0.4, 1) },
    }),
    new DataLayer('point', {
      id: 'zoom-step',
      data: [feature('step', point(12.5, 41.92), {})],
      style: { 'circle-color': '#2040ff', 'circle-radius': 4, 'circle-opacity': ['step', ['zoom'], 0, 8, 1] },
    }),
  ];
}
