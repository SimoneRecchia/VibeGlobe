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
