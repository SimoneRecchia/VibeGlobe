import type { Globe } from '@vibeglobe/core';
import { DataLayer, fitObjects, type Feature } from '@vibeglobe/layers';

declare global {
  interface Window {
    /** `?scenario=data-fit`: the objects and a call fitting the view to them (F387). */
    vibeglobeFit?: { objects: Feature[]; fit(paddingPx: number): Promise<string> };
  }
}

const OBJECTS: Feature[] = [
  { type: 'Feature', id: 'point', properties: {}, geometry: { type: 'Point', coordinates: [12.3, 41.8] } },
  {
    type: 'Feature',
    id: 'line',
    properties: {},
    geometry: {
      type: 'LineString',
      coordinates: [
        [12.4, 41.7],
        [12.9, 42.1],
      ],
    },
  },
  {
    type: 'Feature',
    id: 'polygon',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [12.5, 41.5],
          [12.8, 41.5],
          [12.8, 41.65],
          [12.5, 41.65],
          [12.5, 41.5],
        ],
      ],
    },
  },
  // 3,000 m above the ellipsoid, south of the others: in a tilted view it shows north of its ground point.
  { type: 'Feature', id: 'raised', properties: {}, geometry: { type: 'Point', coordinates: [12.65, 41.45, 3000] } },
];

/** `?scenario=data-fit` (F387): a point, a line, a polygon and a raised point, and `window.vibeglobeFit`. */
export function fitLayers(globe: Globe): DataLayer[] {
  window.vibeglobeFit = {
    objects: OBJECTS,
    fit: (paddingPx) => fitObjects(globe, OBJECTS, { paddingPx }),
  };
  const kinds = { Point: 'point', LineString: 'polyline', Polygon: 'polygon' } as const;
  return (['Point', 'LineString', 'Polygon'] as const).map(
    (kind) =>
      new DataLayer(kinds[kind], {
        id: `fit-${kinds[kind]}`,
        data: OBJECTS.filter((f) => f.geometry?.type === kind),
        style:
          kind === 'Point'
            ? { 'circle-color': '#ff2020', 'circle-radius': 5 }
            : kind === 'LineString'
              ? { 'line-color': '#2050ff', 'line-width': 4 }
              : { 'fill-color': '#20c040', 'fill-opacity': 0.8 },
      }),
  );
}
