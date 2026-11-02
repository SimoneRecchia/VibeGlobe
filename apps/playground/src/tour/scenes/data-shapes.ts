// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** The Data chapter's shapes: placement, extrusions, circles and labels; and GeoJSON, KML and GPX files. */
import {
  DataLayer,
  fitObjects,
  GeoJsonLayer,
  geojsonFormat,
  gpxFormat,
  kmlFormat,
  LabelLayer,
  type Feature,
  type VectorFormatAdapter,
} from '@vibeglobe/layers';
import type { SceneContext, SceneModule } from '../types.js';
import { SAMPLES } from './data-samples.js';
import { freeTilt } from './tilt.js';

/** Cities with a value each, for the bars and the labels. */
const CITIES = [
  ['Milano', 9.19, 45.464, 92],
  ['Torino', 7.687, 45.07, 55],
  ['Genova', 8.934, 44.407, 38],
  ['Bologna', 11.343, 44.494, 61],
  ['Venezia', 12.316, 45.441, 47],
  ['Verona', 10.992, 45.438, 41],
  ['Firenze', 11.256, 43.77, 58],
  ['Trento', 11.121, 46.067, 24],
] as const;

const feature = (id: string, geometry: Feature['geometry'], properties: Record<string, unknown> = {}): Feature => ({
  type: 'Feature',
  id,
  properties,
  geometry,
});

/** A square of `halfDeg` around a point, as a polygon ring. */
const square = (lon: number, lat: number, halfDeg: number): number[][] => [
  [lon - halfDeg, lat - halfDeg * 0.7],
  [lon + halfDeg, lat - halfDeg * 0.7],
  [lon + halfDeg, lat + halfDeg * 0.7],
  [lon - halfDeg, lat + halfDeg * 0.7],
  [lon - halfDeg, lat - halfDeg * 0.7],
];

/** The flight from Turin to Venice, sampled along the way, at `altitude` metres. */
const flight = (altitude: number): number[][] =>
  Array.from({ length: 33 }, (_, i) => [
    7.687 + (12.316 - 7.687) * (i / 32),
    45.07 + (45.441 - 45.07) * (i / 32) + Math.sin((i / 32) * Math.PI) * 0.35,
    altitude,
  ]);

/** The layers on the ground: areas, circles and the flight's track. */
function groundLayers(context: SceneContext): void {
  context.add(
    new DataLayer('polygon', {
      id: 'shapes-regions',
      data: CITIES.map(([name, lon, lat, value]) =>
        feature(`r-${name}`, { type: 'Polygon', coordinates: [square(lon, lat, 0.42)] }, { value }),
      ),
      style: {
        'fill-color': ['interpolate', ['linear'], ['get', 'value'], 20, '#c6e9ff', 90, '#1565c0'],
        'fill-opacity': 0.45,
      },
    }),
  );
  context.add(
    new DataLayer('circle', {
      id: 'shapes-rings',
      data: [50_000, 100_000].map((radiusMeters) =>
        feature(`ring-${String(radiusMeters)}`, { type: 'Point', coordinates: [8.728, 45.63] }, { radiusMeters }),
      ),
      style: { 'fill-color': '#ff7043', 'fill-opacity': 0.14, 'fill-outline-color': '#ff7043' },
    }),
  );
  context.add(
    new DataLayer('polyline', {
      id: 'shapes-track',
      data: [feature('track', { type: 'LineString', coordinates: flight(0).map(([lon = 0, lat = 0]) => [lon, lat]) })],
      style: { 'line-color': '#7b1fa2', 'line-width': 2, 'line-opacity': 0.6 },
    }),
  );
}

/** The layers above the ground: bars, the flight at its altitude and the labels. */
function raisedLayers(context: SceneContext): { bars: DataLayer; route: DataLayer } {
  const bars = context.add(
    new DataLayer('polygon', {
      id: 'shapes-bars',
      data: CITIES.map(([name, lon, lat, value]) =>
        feature(`b-${name}`, { type: 'Polygon', coordinates: [square(lon, lat, 0.05)] }, { value }),
      ),
      style: { 'fill-color': '#ffb300', 'fill-extrusion-height': ['*', ['get', 'value'], 600] },
    }),
  );
  const route = context.add(
    new DataLayer('polyline', {
      id: 'shapes-flight',
      data: [feature('flight', { type: 'LineString', coordinates: flight(9000) })],
      placement: { absoluteAltitudeMeters: 9000 },
      style: { 'line-color': '#e040fb', 'line-width': 3 },
    }),
  );
  context.add(
    new LabelLayer({
      id: 'shapes-labels',
      data: CITIES.map(([name, lon, lat, value]) =>
        feature(`l-${name}`, { type: 'Point', coordinates: [lon, lat] }, { name, rank: -value }),
      ),
      style: {
        'text-field': ['get', 'name'],
        'text-size': 13,
        'text-color': '#ffffff',
        'text-halo-color': '#1b1f24',
        'text-halo-width': 2,
        'text-offset': [0, 1.1],
        'symbol-sort-key': ['get', 'rank'],
      },
    }),
  );
  return { bars, route };
}

/** Draped areas, extruded bars, a line at an altitude over its track, geodesic circles and labels. */
export const shapes: SceneModule = {
  code: `stack.add(new DataLayer('polygon', { data: regions, style: {
  'fill-color': ['interpolate', ['linear'], ['get', 'value'], 20, '#c6e9ff', 90, '#1565c0'],
} })); // draped on the ground
stack.add(new DataLayer('polygon', { data: bars, style: {
  'fill-extrusion-height': ['*', ['get', 'value'], 600], // metres
} }));
stack.add(new DataLayer('polyline', { data: [route], placement: { absoluteAltitudeMeters: 9000 } }));
stack.add(new DataLayer('circle', { data: [{ /* … */ properties: { radiusMeters: 50_000 } }] }));`,
  start(context) {
    const { panel, layers } = context;
    freeTilt(context);
    context.go({ longitudeDeg: 10.2, latitudeDeg: 43.75, zoom: 6.9, tiltDeg: 52, headingDeg: 8 });
    groundLayers(context);
    const { bars, route } = raisedLayers(context);
    panel.slider(
      'Bar height',
      { min: 0, max: 2000, step: 50, value: 600, format: (v) => `${String(v)} m per unit` },
      (v) => bars.setStyle({ 'fill-color': '#ffb300', 'fill-extrusion-height': ['*', ['get', 'value'], v] }),
    );
    panel.slider(
      'Flight altitude',
      { min: 0, max: 30_000, step: 500, value: 9000, format: (v) => `${(v / 1000).toFixed(1)} km` },
      (v) => route.updateFeature('flight', { geometry: { type: 'LineString', coordinates: flight(v) } }),
    );
    const group = panel.group('Layers');
    for (const [id, label] of [
      ['shapes-regions', 'Draped areas'],
      ['shapes-bars', 'Extruded bars'],
      ['shapes-flight', 'Line at an altitude'],
      ['shapes-rings', 'Geodesic circles'],
      ['shapes-labels', 'Labels'],
    ] as const)
      group.toggle(label, true, (on) => layers.stack.setVisible(id, on));
  },
};

const FORMATS: Readonly<Record<string, VectorFormatAdapter>> = {
  geojson: geojsonFormat,
  json: geojsonFormat,
  kml: kmlFormat,
  kmz: kmlFormat,
  gpx: gpxFormat,
};

/** Shows parsed features as the scene's file layer and frames them. */
async function showFile(
  context: SceneContext,
  input: string | Uint8Array,
  format: VectorFormatAdapter,
): Promise<string> {
  const parsed = await format.parse(input);
  if (context.layers.stack.get('file-data')) context.layers.stack.remove('file-data');
  if (parsed.features.length === 0) return `Nothing to draw (${String(parsed.issues.length)} issues)`;
  const layer = context.add(
    new GeoJsonLayer({
      id: 'file-data',
      data: { type: 'FeatureCollection', features: [...parsed.features] },
      // GPX and KML heights are above the ellipsoid; positions without one stand on it.
      placement: { absoluteAltitudeMeters: 0 },
      style: {
        point: {
          'circle-color': '#ff3d00',
          'circle-radius': 6,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
        line: { 'line-color': '#d500f9', 'line-width': 4 },
        polygon: { 'fill-color': '#00b8d4', 'fill-opacity': 0.35, 'fill-outline-color': '#00838f' },
      },
    }),
  );
  await layer.loaded;
  void fitObjects(context.globe, [...parsed.features], { paddingPx: 60 });
  const counts = layer.featureCounts;
  return `${String(counts.point)} points · ${String(counts.line)} lines · ${String(counts.polygon)} areas`;
}

/** Sample files and a drop zone. */
export const files: SceneModule = {
  code: `import { GeoJsonLayer, kmlFormat } from '@vibeglobe/layers';

const routes = stack.add(new GeoJsonLayer({
  data: file, // a File, a URL ({ url }), text, bytes or a FeatureCollection
  format: kmlFormat, // geojsonFormat (default), kmlFormat (KML and KMZ), gpxFormat
  style: { line: { 'line-color': '#d500f9', 'line-width': 4 } },
}));
await routes.loaded;`,
  start(context) {
    const { panel } = context;
    context.go({ longitudeDeg: 9.5, latitudeDeg: 45.8, zoom: 6, tiltDeg: 0, headingDeg: 0 });
    const readout = panel.readout();
    const load = (input: string | Uint8Array, format: VectorFormatAdapter): void =>
      void showFile(context, input, format).then(
        (summary) => readout([['Loaded', summary]]),
        (error: unknown) => readout([['Error', String(error)]]),
      );
    panel.buttons(
      ['GeoJSON sample', () => load(SAMPLES.geojson, geojsonFormat)],
      ['KML sample', () => load(SAMPLES.kml, kmlFormat)],
      ['GPX track', () => load(SAMPLES.gpx, gpxFormat)],
    );
    panel.files('Your own file', '.geojson,.json,.kml,.kmz,.gpx', (file) => {
      const format = FORMATS[file.name.split('.').pop()?.toLowerCase() ?? ''];
      if (!format) return readout([['Error', `${file.name}: not GeoJSON, KML or GPX`]]);
      void file
        .arrayBuffer()
        .then((bytes) =>
          load(/\.kmz$/i.test(file.name) ? new Uint8Array(bytes) : new TextDecoder().decode(bytes), format),
        );
    });
    load(SAMPLES.gpx, gpxFormat);
  },
};
