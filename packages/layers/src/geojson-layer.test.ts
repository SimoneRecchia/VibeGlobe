import { describe, expect, it } from 'vitest';
import { frameAt } from './__fixtures__/test-support.js';
import type { FeatureCollection } from './geojson.js';
import { GeoJsonLayer } from './geojson-layer.js';
import { LayerStack } from './layer-stack.js';
import { RecordingRenderTarget } from './render-target.js';

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
    expect(badPosition.errors[0]).toMatch(/invalid position/);
  });
});
