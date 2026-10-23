import { describe, expect, it } from 'vitest';
import { frameAt } from './__fixtures__/test-support.js';
import type { FeatureCollection } from './geojson.js';
import { GeoJsonLayer } from './geojson-layer.js';
import type { WorkerPool } from '@vibeglobe/core';
import { VECTOR_TASKS } from '@vibeglobe/sources/vector';
import { geojsonFormat, gpxFormat, kmlFormat, loadVectorData } from './vector-format.js';
import { LayerStack } from './layer-stack.js';
import { RecordingRenderTarget } from './testing.js';

const collection: FeatureCollection = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', id: 'p', properties: { name: 'Roma' }, geometry: { type: 'Point', coordinates: [12.5, 41.9] } },
    {
      type: 'Feature',
      id: 'l',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [10, 10, 5],
        ],
      },
    },
    {
      type: 'Feature',
      id: 'g',
      properties: { h: 30 },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [4, 0],
            [4, 4],
            [0, 0],
          ],
          [
            [1, 1],
            [2, 1],
            [2, 2],
            [1, 1],
          ],
        ],
      },
    },
  ],
};

async function load(
  data: ConstructorParameters<typeof GeoJsonLayer>[0]['data'],
  fetchFn?: (url: string) => Promise<Response>,
) {
  const target = new RecordingRenderTarget();
  const stack = new LayerStack(target);
  const errors: string[] = [];
  const layer = new GeoJsonLayer({ data, ...(fetchFn === undefined ? {} : { fetch: fetchFn }) });
  layer.on('error', (e) => errors.push(e.message));
  stack.add(layer);
  await layer.loaded;
  stack.frame(frameAt(0, 5));
  return { layer, target, errors };
}

describe('vector data layer', () => {
  it('loads GeoJSON from memory, text, a File and a URL into points, lines and polygons', async () => {
    const text = JSON.stringify(collection);
    const sources = [collection, text, new File([text], 'data.geojson'), new URL('https://tiles.example/data.geojson')];
    const fetchFn = (url: string): Promise<Response> =>
      Promise.resolve(new Response(url.endsWith('data.geojson') ? text : '', { status: 200 }));
    for (const source of sources) {
      const { layer, target, errors } = await load(source, fetchFn);
      expect(errors).toEqual([]);
      expect(layer.featureCounts).toEqual({ point: 1, line: 1, polygon: 1 });
      // Batches are created polygon, line, point: polygons draw lowest.
      expect(target.state({ id: 1 }).order).toBeLessThan(target.state({ id: 2 }).order);
      const polygon = target.geometry({ id: 1 }, 0);
      expect([...(polygon?.partStarts ?? [])]).toEqual([0, 4]);
      expect(target.geometry({ id: 2 }, 0)?.positions[5]).toBe(5);
      expect(target.value({ id: 3 }, 'position', 0, 0)).toBe(12.5);
      expect(layer.part('point').getFeature('p')?.properties).toEqual({ name: 'Roma' });
    }
  });

  it('emits an error event for corrupted input and keeps the view intact', async () => {
    const broken = [
      '{"type": "FeatureCollection", "features": [',
      '{"type":"Topology"}',
      '{"type":"Feature","geometry":{"type":"Circle","coordinates":[]}}',
    ];
    for (const source of broken) {
      const { layer, errors } = await load(source);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/^geojson: /);
      expect(layer.featureCounts).toEqual({ point: 0, line: 0, polygon: 0 });
    }
    const missing = await load(new URL('https://tiles.example/missing.geojson'), () =>
      Promise.resolve(new Response('', { status: 404 })),
    );
    expect(missing.errors[0]).toMatch(/404/);
    const badPosition = await load({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0, 120] } }],
    });
    expect(badPosition.errors[0]).toMatch(/^geojson: feature 0: .*120/);
  });

  it('loads KML placemarks and GPX waypoints, routes and tracks through the M7 adapters', async () => {
    const kml = `<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document>
      <Placemark id="rome"><name>Roma</name><Point><coordinates>12.5,41.9,0</coordinates></Point></Placemark>
      <Placemark id="road"><LineString><coordinates>0,0 1,1 2,1</coordinates></LineString></Placemark>
      <Placemark id="area"><Polygon><outerBoundaryIs><LinearRing><coordinates>0,0 4,0 4,4 0,0</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
    </Document></kml>`;
    const gpx = `<?xml version="1.0"?><gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
      <wpt lat="45.8" lon="6.86"><name>Mont Blanc</name></wpt>
      <trk><trkseg><trkpt lat="45" lon="6"/><trkpt lat="45.1" lon="6.1"/></trkseg></trk>
    </gpx>`;
    for (const [format, text, counts] of [
      [kmlFormat, kml, { point: 1, line: 1, polygon: 1 }],
      [gpxFormat, gpx, { point: 1, line: 1, polygon: 0 }],
    ] as const) {
      const target = new RecordingRenderTarget();
      const stack = new LayerStack(target);
      const errors: string[] = [];
      const layer = new GeoJsonLayer({ data: new File([text], `data.${format.format}`), format });
      layer.on('error', (e) => errors.push(e.message));
      stack.add(layer);
      await layer.loaded;
      expect(errors).toEqual([]);
      expect(layer.featureCounts).toEqual(counts);
    }
    for (const [format, text] of [
      [kmlFormat, 'not xml at all'],
      [gpxFormat, '<html><body>404</body></html>'],
    ] as const) {
      const broken = new GeoJsonLayer({ data: text, format });
      const errors: string[] = [];
      broken.on('error', (e) => errors.push(e.message));
      new LayerStack(new RecordingRenderTarget()).add(broken);
      await broken.loaded;
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(new RegExp(`^${format.format}: `));
    }
  });
});

describe('vector data layer in and out of the stack', () => {
  it('keeps its features once when removed and added again, also during the first load (PT-08)', async () => {
    const stack = new LayerStack(new RecordingRenderTarget());
    const errors: string[] = [];
    const layer = new GeoJsonLayer({ data: collection });
    stack.add(layer);
    await layer.loaded;
    stack.remove(layer);
    stack.add(layer);
    layer.on('error', (e) => errors.push(e.message));
    await layer.loaded;
    expect(layer.featureCounts).toEqual({ point: 1, line: 1, polygon: 1 });
    const slow = new GeoJsonLayer({ data: JSON.stringify(collection) });
    stack.add(slow);
    stack.remove(slow);
    stack.add(slow);
    slow.on('error', (e) => errors.push(e.message));
    await slow.loaded;
    expect(slow.featureCounts).toEqual({ point: 1, line: 1, polygon: 1 });
    expect(errors).toEqual([]);
  });
});

describe('vector data layer with multi-points', () => {
  it('draws every point of a MultiPoint (PT-09)', async () => {
    const { layer } = await load({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          id: 'm',
          properties: {},
          geometry: {
            type: 'MultiPoint',
            coordinates: [
              [1, 1],
              [2, 2],
              [3, 3],
            ],
          },
        },
        { type: 'Feature', id: 'p', properties: {}, geometry: { type: 'Point', coordinates: [4, 4] } },
      ],
    });
    expect(layer.featureCounts.point).toBe(4);
  });

  it('parses in the worker pool when given one, transferring the bytes (F371)', async () => {
    const tasks: string[] = [];
    const transferred: object[] = [];
    const pool = {
      run(request, done) {
        tasks.push(request.task);
        transferred.push(...(request.transfer ?? []));
        void Promise.resolve(VECTOR_TASKS[request.task]?.(request.input, {} as never)).then((result) =>
          done({ ok: true, output: result?.output }),
        );
        return 1;
      },
    } as Pick<WorkerPool, 'run'> as WorkerPool;
    const bytes = new TextEncoder().encode(JSON.stringify(collection)).buffer;
    const parsed = await loadVectorData(bytes, geojsonFormat, undefined, pool);
    expect(tasks).toEqual(['parse-geojson']);
    expect(parsed.features.map((feature) => feature.id)).toEqual(collection.features.map((feature) => feature.id));
    // The bytes go to the worker without a copy.
    expect(transferred).toEqual([bytes]);
  });
});
