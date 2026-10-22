// The vector adapters parse in a worker (F236–F239): each format's task runs in a module worker of the page and
// returns the engine's feature structures, while the main thread never parses.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const WORKER = `/@fs${resolve('e2e/support/vector-worker.ts')}`;
const fixture = (path: string): number[] => [...readFileSync(`packages/sources/src/__fixtures__/${path}`)];

test('GeoJSON, KML, GPX and MVT are parsed in a worker', async ({ page }) => {
  await page.goto('/');
  const inputs = {
    'parse-geojson': [
      ...Buffer.from(
        JSON.stringify({
          type: 'Feature',
          properties: { a: 1 },
          geometry: { type: 'Point', coordinates: [12.5, 41.9] },
        }),
      ),
    ],
    'parse-kml': fixture('vector/synthetic.kml'),
    'parse-gpx': fixture('vector/run.gpx'),
    'decode-mvt': fixture('mvt/real-chicago-13-2098-3045.mvt'),
  };
  const replies = await page.evaluate(
    async ({ url, tasks }) => {
      const worker = new Worker(url, { type: 'module' });
      const out: Record<string, { inWorker: boolean; count: number }> = {};
      for (const [task, bytes] of Object.entries(tasks)) {
        const buffer = new Uint8Array(bytes).buffer;
        const reply = await new Promise<{ inWorker: boolean; output: { features?: unknown[]; layers?: unknown[] } }>(
          (done) => {
            worker.onmessage = (event) => done(event.data);
            worker.postMessage({ task, input: { bytes: buffer } }, [buffer]);
          },
        );
        out[task] = { inWorker: reply.inWorker, count: (reply.output.features ?? reply.output.layers ?? []).length };
      }
      worker.terminate();
      return out;
    },
    { url: WORKER, tasks: inputs },
  );
  expect(replies).toEqual({
    'parse-geojson': { inWorker: true, count: 1 },
    'parse-kml': { inWorker: true, count: 4 },
    'parse-gpx': { inWorker: true, count: 1 },
    'decode-mvt': { inWorker: true, count: expect.any(Number) },
  });
  expect(replies['decode-mvt']?.count).toBeGreaterThan(0);
});
