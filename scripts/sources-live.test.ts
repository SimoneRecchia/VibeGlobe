import { describe, expect, it } from 'vitest';
import { runLiveSuite } from './sources-live.ts';

const OSM = 'https://osm.fixture.test/{z}/{x}/{y}.png';

/** A fixture OpenStreetMap raster server, answering `status` (200 by default). */
function osmServer(status = 200): typeof fetch {
  return () => Promise.resolve(status === 200 ? new Response(new Uint8Array([1, 2, 3])) : new Response('', { status }));
}

describe('live source suite (F223)', () => {
  it('runs the endpoints whose terms allow it and records every skipped endpoint with its reason', async () => {
    const report = await runLiveSuite({ fetch: osmServer(), osmUrl: OSM });
    expect(report.ran).toEqual(['OpenStreetMap public raster servers (3 tiles)']);
    expect(report.skipped.map((s) => s.endpoint)).toEqual(['WMTS, WMS', 'PMTiles, MBTiles', 'vector formats']);
    expect(report.skipped.every((s) => s.reason.length > 0)).toBe(true);
    expect(report.requests['osm.fixture.test']).toBe(3);
  });

  it('stops at the first quota error with a clear message', async () => {
    const report = await runLiveSuite({ fetch: osmServer(429), osmUrl: OSM });
    expect(report.stoppedBy).toMatch(/quota error from osm\.fixture\.test \(HTTP 429\): the live run stops here/);
    expect(report.requests).toEqual({ 'osm.fixture.test': 1 });
  });
});
