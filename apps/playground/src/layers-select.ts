import { DataLayer, type Feature, type Geometry } from '@vibeglobe/layers';
import { ModelLayer } from '@vibeglobe/layers/models';

function feature(id: string, geometry: Geometry, properties: Record<string, unknown> = {}): Feature {
  return { type: 'Feature', id, properties, geometry };
}

function rectangle(west: number, south: number, east: number, north: number): number[][] {
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
}

/** Yellow while the feature is selected, cyan while hovered (F379), else `color`. */
const selectable = (color: string) => [
  'case',
  ['boolean', ['feature-state', 'selected'], false],
  '#ffff00',
  ['boolean', ['feature-state', 'hover'], false],
  '#00e0ff',
  color,
];

/**
 * `?scenario=data-select` (F381): one feature of each data-layer primitive near Rome (a point, a line, a polygon, a
 * geodesic circle, a marker, a label and an extrusion), each turning yellow while selected and cyan while hovered
 * (the marker growing instead).
 * Seen in 2D at zoom 9 centered on (12.5°, 41.88°).
 */
export function selectLayers(): DataLayer[] {
  return [
    new DataLayer('point', {
      id: 'sel-point',
      data: [feature('pt', { type: 'Point', coordinates: [12.35, 42.0] })],
      style: { 'circle-color': selectable('#ff2020'), 'circle-radius': 8 },
    }),
    new DataLayer('polyline', {
      id: 'sel-line',
      data: [
        feature('ln', {
          type: 'LineString',
          coordinates: [
            [12.45, 42.0],
            [12.55, 42.0],
          ],
        }),
      ],
      style: { 'line-color': selectable('#2050ff'), 'line-width': 8 },
    }),
    new DataLayer('polygon', {
      id: 'sel-polygon',
      data: [feature('pg', { type: 'Polygon', coordinates: [rectangle(12.6, 41.97, 12.7, 42.03)] })],
      style: { 'fill-color': selectable('#20c040'), 'fill-opacity': 1 },
    }),
    new DataLayer('circle', {
      id: 'sel-circle',
      data: [feature('cr', { type: 'Point', coordinates: [12.35, 41.85] }, { radiusMeters: 3000 })],
      style: { 'fill-color': selectable('#ff8000'), 'fill-opacity': 1 },
    }),
    new DataLayer('marker', {
      id: 'sel-marker',
      data: [feature('mk', { type: 'Point', coordinates: [12.5, 41.85] })],
      style: {
        'icon-image': 'square',
        'icon-size': [
          'case',
          ['boolean', ['feature-state', 'selected'], false],
          40,
          ['boolean', ['feature-state', 'hover'], false],
          32,
          24,
        ],
      },
    }),
    new DataLayer('label', {
      id: 'sel-label',
      data: [feature('lb', { type: 'Point', coordinates: [12.65, 41.85] }, { t: 'Roma' })],
      style: { 'text-field': ['get', 't'], 'text-size': 22, 'text-color': selectable('#ffffff') },
    }),
    new DataLayer('polygon', {
      id: 'sel-extrusion',
      data: [feature('ex', { type: 'Polygon', coordinates: [rectangle(12.45, 41.72, 12.55, 41.76)] })],
      style: { 'fill-color': selectable('#c0a080'), 'fill-extrusion-height': 500 },
    }),
  ];
}

/** The glTF model of `?scenario=data-select`: the fixture pyramid (2 by 4 units) 5 km across, south-west of the other features. */
export function selectModels(baseUrl: string): ModelLayer {
  return new ModelLayer({
    id: 'sel-model',
    models: [
      {
        id: 'md',
        url: `${baseUrl}models/pyramid.gltf`,
        position: { longitudeDeg: 12.35, latitudeDeg: 41.74 },
        scale: 2500,
      },
    ],
  });
}
