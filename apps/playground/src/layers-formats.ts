import type { Globe, WorkerEndpointFactory } from '@vibeglobe/core';
import { createGlobeLayers, GeoJsonLayer, gpxFormat, kmlFormat, type VectorFormatAdapter } from '@vibeglobe/layers';
import { createWorkers } from '@vibeglobe/worker';

/** The same data in each format: a point at Rome, a line east of it and (GeoJSON, KML) a polygon south of it. */
const DOCUMENTS = {
  geojson: JSON.stringify({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'p',
        properties: { name: 'Roma' },
        geometry: { type: 'Point', coordinates: [12.5, 41.9] },
      },
      {
        type: 'Feature',
        id: 'l',
        properties: { name: 'east' },
        geometry: {
          type: 'LineString',
          coordinates: [
            [12.6, 41.9],
            [12.8, 41.9],
          ],
        },
      },
      {
        type: 'Feature',
        id: 'a',
        properties: { name: 'south' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [12.4, 41.7],
              [12.6, 41.7],
              [12.6, 41.8],
              [12.4, 41.8],
              [12.4, 41.7],
            ],
          ],
        },
      },
    ],
  }),
  kml: `<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>
<Placemark id="p"><name>Roma</name><Point><coordinates>12.5,41.9</coordinates></Point></Placemark>
<Placemark id="l"><name>east</name><LineString><coordinates>12.6,41.9 12.8,41.9</coordinates></LineString></Placemark>
<Placemark id="a"><name>south</name><Polygon><outerBoundaryIs><LinearRing><coordinates>12.4,41.7 12.6,41.7 12.6,41.8 12.4,41.8 12.4,41.7</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
</Document></kml>`,
  gpx: `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="vibeglobe" xmlns="http://www.topografix.com/GPX/1/1">
<wpt lat="41.9" lon="12.5"><name>Roma</name></wpt>
<rte><name>east</name><rtept lat="41.9" lon="12.6"/><rtept lat="41.9" lon="12.8"/></rte>
</gpx>`,
} as const;

const FORMATS: Record<keyof typeof DOCUMENTS, VectorFormatAdapter | undefined> = {
  geojson: undefined,
  kml: kmlFormat,
  gpx: gpxFormat,
};

/** What a load reports back to the test. */
export interface FormatLoad {
  readonly counts: Readonly<Record<string, number>>;
  /** The `name` property of the point at Rome. */
  readonly pointName: string;
  readonly errors: readonly string[];
}

/**
 * `?scenario=data-formats` (F371): `window.vibeglobeFormats.load(format, from, corrupt?)` loads GeoJSON, KML or GPX
 * from a URL (a blob URL), a File or memory into a `GeoJsonLayer` parsed in its own worker pool, whose posted tasks
 * `tasks` lists; `clear()` removes the layers.
 */
export function showFormats(globe: Globe): void {
  const { stack } = createGlobeLayers(globe);
  const base = createWorkers();
  const tasks: string[] = [];
  // A pool of its own (one per URL label), so the test sees which tasks went to a worker.
  const workers: WorkerEndpointFactory = {
    ...base,
    url: `${base.url}#formats`,
    create(onMessage, onError) {
      const endpoint = base.create(onMessage, onError);
      return {
        post(message, transfer) {
          if ('task' in message) tasks.push(message.task);
          endpoint.post(message, transfer);
        },
        terminate: () => endpoint.terminate(),
      };
    },
  };
  let next = 0;
  window.vibeglobeFormats = {
    tasks,
    async load(format: keyof typeof DOCUMENTS, from: 'url' | 'file' | 'memory', corrupt = false): Promise<FormatLoad> {
      // Corrupted: the point's longitude is not a number (and the GeoJSON no longer JSON).
      const text = corrupt ? DOCUMENTS[format].replaceAll('12.5', 'x!') : DOCUMENTS[format];
      const data =
        from === 'url'
          ? { url: URL.createObjectURL(new Blob([text])) }
          : from === 'file'
            ? new File([text], `data.${format}`)
            : format === 'geojson' && !corrupt
              ? JSON.parse(text)
              : text;
      const errors: string[] = [];
      const format_ = FORMATS[format];
      const layer = new GeoJsonLayer({
        id: `formats-${String(++next)}`,
        data,
        workers,
        ...(format_ ? { format: format_ } : {}),
        style: {
          point: { 'circle-color': '#ff2020', 'circle-radius': 6 },
          line: { 'line-color': '#2050ff', 'line-width': 4 },
        },
      });
      layer.on('error', (error) => errors.push(error.message));
      stack.add(layer);
      await layer.loaded;
      // GPX has no feature ids: its point is checked by count and drawing only.
      const roma = format === 'gpx' ? undefined : layer.part('point').getFeature('p');
      return { counts: { ...layer.featureCounts }, pointName: String(roma?.properties['name'] ?? ''), errors };
    },
    clear: () => stack.clear(),
  };
}

declare global {
  interface Window {
    vibeglobeFormats?: {
      readonly tasks: readonly string[];
      load(format: 'geojson' | 'kml' | 'gpx', from: 'url' | 'file' | 'memory', corrupt?: boolean): Promise<FormatLoad>;
      clear(): void;
    };
  }
}
