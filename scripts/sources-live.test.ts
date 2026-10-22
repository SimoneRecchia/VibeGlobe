import { describe, expect, it } from 'vitest';
import { GOOGLE_FIXTURE_KEY, googleFixture } from '../packages/sources/src/__fixtures__/google-server.ts';
import { GOOGLE_FREE_MONTHLY, GOOGLE_REQUESTS_PER_RUN, LIVE_RUNS_PER_MONTH, runLiveSuite } from './sources-live.ts';

const GOOGLE = 'https://google.fixture.test/';
const OSM = 'https://osm.fixture.test/{z}/{x}/{y}.png';

/** The fixture Google server and a fixture OpenStreetMap raster server behind one fetch. */
function servers() {
  const google = googleFixture((z, x, y) => new TextEncoder().encode(`${z}/${x}/${y}`), GOOGLE);
  const fetchImpl: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith('https://osm.fixture.test/')) return Promise.resolve(new Response(new Uint8Array([1, 2, 3])));
    return google.fetch(input, init);
  };
  return { google, fetch: fetchImpl };
}

describe('live source suite (F223, F549)', () => {
  it('does not run Google without a key, says so, and records every skipped endpoint with its reason', async () => {
    const { fetch } = servers();
    const report = await runLiveSuite({ fetch, googleBaseUrl: GOOGLE, osmUrl: OSM });
    expect(report.ran).toEqual(['OpenStreetMap public raster servers (3 tiles)']);
    expect(report.skipped.map((s) => s.endpoint)).toEqual([
      'WMTS, WMS',
      'PMTiles, MBTiles',
      'vector formats',
      'Google Map Tiles API',
    ]);
    expect(report.skipped.at(-1)?.reason).toMatch(/GOOGLE_MAPS_API_KEY is not set/);
    expect(report.requests['google.fixture.test']).toBeUndefined();
    expect(report.requests['osm.fixture.test']).toBe(3);
  });

  it('runs Google with a key within the request budget, which stays far below the free monthly caps', async () => {
    const { fetch } = servers();
    const report = await runLiveSuite({ googleApiKey: GOOGLE_FIXTURE_KEY, fetch, googleBaseUrl: GOOGLE, osmUrl: OSM });
    expect([report.failed, report.stoppedBy]).toEqual([[], undefined]);
    expect(report.ran).toHaveLength(3);
    const budget =
      GOOGLE_REQUESTS_PER_RUN.tiles2d + GOOGLE_REQUESTS_PER_RUN.streetViewTiles + GOOGLE_REQUESTS_PER_RUN.other;
    expect(report.requests['google.fixture.test']).toBeLessThanOrEqual(budget);
    expect(GOOGLE_REQUESTS_PER_RUN.tiles2d * LIVE_RUNS_PER_MONTH).toBeLessThan(GOOGLE_FREE_MONTHLY.tiles2d / 10);
    expect(GOOGLE_REQUESTS_PER_RUN.streetViewTiles * LIVE_RUNS_PER_MONTH).toBeLessThan(
      GOOGLE_FREE_MONTHLY.streetViewTiles / 10,
    );
  });

  it('stops at the first quota error with a clear message', async () => {
    const { google, fetch } = servers();
    google.exhaustQuota();
    const report = await runLiveSuite({ googleApiKey: GOOGLE_FIXTURE_KEY, fetch, googleBaseUrl: GOOGLE, osmUrl: OSM });
    expect(report.stoppedBy).toMatch(/quota error from google\.fixture\.test \(HTTP 429\): the live run stops here/);
    expect(report.requests).toEqual({ 'google.fixture.test': 1 });
  });
});
