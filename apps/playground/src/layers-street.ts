import type { Globe } from '@vibeglobe/core';
import { createGlobeLayers, DataLayer, type Feature, type Geometry } from '@vibeglobe/layers';

/**
 * `?scenario=data-street` (F367): one primitive of each kind within 25 cm of the URL's `lon`, `lat`, for the street
 * level jitter check (visible to zoom 30, beyond the default 24): a magenta point, a blue line, a green square, a yellow label and the red pyramid model.
 */
export function showStreet(globe: Globe): void {
  const params = new URLSearchParams(location.search);
  const lon = Number(params.get('lon') ?? 0);
  const lat = Number(params.get('lat') ?? 0);
  // Meters east and north of the position, as degrees.
  const at = (east: number, north: number): [number, number] => [
    lon + east / (111_320 * Math.cos((lat * Math.PI) / 180)),
    lat + north / 110_574,
  ];
  const feature = (id: string, geometry: Geometry, properties: Record<string, unknown> = {}): Feature => ({
    type: 'Feature',
    id,
    properties,
    geometry,
  });
  const square = [at(-0.2, 0), at(-0.1, 0), at(-0.1, 0.1), at(-0.2, 0.1), at(-0.2, 0)];
  const { stack } = createGlobeLayers(globe);
  stack.add(
    new DataLayer('polygon', {
      id: 'street-polygon',
      maxZoom: 30,
      data: [feature('square', { type: 'Polygon', coordinates: [square] })],
      style: { 'fill-color': '#20c020' },
    }),
  );
  stack.add(
    new DataLayer('polyline', {
      id: 'street-line',
      maxZoom: 30,
      data: [feature('line', { type: 'LineString', coordinates: [at(-0.15, -0.15), at(0.15, -0.15)] })],
      style: { 'line-color': '#2040ff', 'line-width': 6 },
    }),
  );
  stack.add(
    new DataLayer('point', {
      id: 'street-point',
      maxZoom: 30,
      data: [feature('point', { type: 'Point', coordinates: at(0.15, -0.05) })],
      style: { 'circle-color': '#ff00ff', 'circle-radius': 8 },
    }),
  );
  stack.add(
    new DataLayer('label', {
      id: 'street-label',
      maxZoom: 30,
      data: [feature('label', { type: 'Point', coordinates: at(0.1, 0.08) }, { t: 'X' })],
      style: { 'text-field': ['get', 't'], 'text-size': 28, 'text-color': '#ffe000' },
    }),
  );
  const [modelLon, modelLat] = at(0, 0);
  void globe
    .addModel({
      url: `${import.meta.env.BASE_URL}models/pyramid.gltf`,
      // 5 mm up: the pyramid's base lies in its ground plane, which would fight with the surface for depth.
      position: { longitudeDeg: modelLon, latitudeDeg: modelLat, heightMeters: 0.005 },
      scale: 0.02,
    })
    .then(() => (document.body.dataset['street'] = 'ready'));
}
