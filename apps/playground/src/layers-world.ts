import { DataLayer, type Feature, type Geometry } from '@vibeglobe/layers';

function feature(id: string, geometry: Geometry, properties: Record<string, unknown> = {}): Feature {
  return { type: 'Feature', id, properties, geometry };
}

/**
 * `?scenario=data-antimeridian` (F368): a line, a polygon, a circle and a label across ±180°, a polygon ring at 80°N
 * around the north pole and a circle containing the south pole.
 */
export function antimeridianLayers(): DataLayer[] {
  const polar = Array.from({ length: 9 }, (_, i) => [((i * 45 + 180) % 360) - 180, 80]);
  return [
    new DataLayer('polygon', {
      id: 'am-polygons',
      data: [
        feature('across', {
          type: 'Polygon',
          coordinates: [
            [
              [175, -20],
              [-175, -20],
              [-175, -10],
              [175, -10],
              [175, -20],
            ],
          ],
        }),
      ],
      style: { 'fill-color': '#ff8000', 'fill-opacity': 1 },
    }),
    new DataLayer('polygon', {
      id: 'am-north',
      data: [feature('north-cap', { type: 'Polygon', coordinates: [polar] })],
      style: { 'fill-color': '#ff00ff', 'fill-opacity': 1 },
    }),
    new DataLayer('circle', {
      id: 'am-circles',
      data: [
        feature('across-circle', { type: 'Point', coordinates: [180, 40] }, { radiusMeters: 400_000 }),
        feature('south-cap', { type: 'Point', coordinates: [0, -89.5] }, { radiusMeters: 300_000 }),
      ],
      style: { 'fill-color': '#00e0ff', 'fill-opacity': 1 },
    }),
    new DataLayer('polyline', {
      id: 'am-lines',
      data: [
        feature('across-line', {
          type: 'LineString',
          coordinates: [
            [170, 10],
            [-170, 20],
          ],
        }),
      ],
      style: { 'line-color': '#40ff40', 'line-width': 6 },
    }),
    new DataLayer('label', {
      id: 'am-labels',
      data: [feature('across-label', { type: 'Point', coordinates: [180, -32] }, { t: 'AM' })],
      style: { 'text-field': ['get', 't'], 'text-size': 24, 'text-color': '#ffffff' },
    }),
  ];
}
