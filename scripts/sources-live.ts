// The opt-in live run of the source adapters (F223, F549): `npm run test:live-sources` runs the conformance checks
// against real public endpoints only where the provider's terms allow automated testing, reports every endpoint it
// skipped and why, and stops at the first quota error. Google runs only with the owner's GOOGLE_MAPS_API_KEY, under the
// EEA terms of the owner's billing region (ADR 0031); the OpenStreetMap public servers at the low volume ADR 0032 allows.
import { pathToFileURL } from 'node:url';
import { googleImagery, googleStreetView, openStreetMapImagery, type DescribedImagerySource } from '@vibeglobe/sources';

/** What one live run did. */
export interface LiveReport {
  readonly ran: string[];
  readonly skipped: { readonly endpoint: string; readonly reason: string }[];
  readonly failed: { readonly endpoint: string; readonly reason: string }[];
  /** Requests sent to each provider. */
  readonly requests: Record<string, number>;
  /** Set when a quota error stopped the run. */
  stoppedBy?: string;
}

/** Most requests one run sends to each Google product, against the free monthly caps of ADR 0031. */
export const GOOGLE_REQUESTS_PER_RUN = { tiles2d: 36, streetViewTiles: 4, other: 8 } as const;
/** Free monthly events of the Map Tiles API products used (ADR 0031). */
export const GOOGLE_FREE_MONTHLY = { tiles2d: 100_000, streetViewTiles: 100_000 } as const;
/** Scheduled live runs per month at most (nightly). */
export const LIVE_RUNS_PER_MONTH = 31;

/** Endpoints whose terms do not allow automated testing, or that have no public endpoint: never contacted. */
const NEVER_LIVE: readonly { endpoint: string; reason: string }[] = [
  {
    endpoint: 'WMTS, WMS',
    reason: 'no public service whose terms allow automated testing is configured; recorded capabilities only',
  },
  { endpoint: 'PMTiles, MBTiles', reason: 'self-hosted package formats: fixtures only' },
  { endpoint: 'vector formats', reason: 'documents, not services: fixtures only' },
];

/** A fetch that counts requests per host and records a quota answer, which stops the run (F549). */
function guardedFetch(base: typeof fetch, report: LiveReport): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    report.requests[url.host] = (report.requests[url.host] ?? 0) + 1;
    const response = await base(input, init);
    const text = response.status === 429 || response.status === 403 ? await response.clone().text() : '';
    if (response.status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(text))
      report.stoppedBy ??= `quota error from ${url.host} (HTTP ${response.status}): the live run stops here`;
    return response;
  };
}

async function tiles(source: DescribedImagerySource, coords: readonly [number, number, number][]): Promise<void> {
  for (const [level, x, y] of coords) {
    const request = source.request({ root: 0, level, x, y }, { url: '', hostIndex: 0 });
    if (request === 'noData' || request === 'unknown') throw new Error(`${level}/${x}/${y} reported as no data`);
    const result = await new Promise<{ kind: string }>((done) =>
      source.transport.start(request, { firstByteMs: 10_000, totalMs: 30_000 }, done),
    );
    if (result.kind !== 'ok') throw new Error(`${level}/${x}/${y}: ${JSON.stringify(result)}`);
  }
}

/** The tile of level `z` that contains a position. */
function tileAt(lonDeg: number, latDeg: number, z: number): [number, number, number] {
  const n = 2 ** z;
  const lat = (latDeg * Math.PI) / 180;
  return [z, Math.floor(((lonDeg + 180) / 360) * n), Math.floor(((1 - Math.asinh(Math.tan(lat)) / Math.PI) / 2) * n)];
}

/** Twelve tiles per map type: the world, then Rome at levels 4 to 14. */
const GOOGLE_TILES = [
  [0, 0, 0] as [number, number, number],
  ...[...Array(11).keys()].map((i) => tileAt(12.4922, 41.8902, 4 + i)),
];

async function google(
  key: string,
  fetchImpl: typeof fetch,
  report: LiveReport,
  billingRegion: 'eea' | 'other',
  baseUrl?: string,
): Promise<void> {
  const common = { apiKey: key, billingRegion, fetch: fetchImpl, ...(baseUrl ? { baseUrl } : {}) };
  // An EEA billing account gets neither satellite tiles nor Street View (Map Tiles API EEA terms, ADR 0031).
  const eea = billingRegion === 'eea';
  const mapTypes = eea ? (['roadmap', 'terrain'] as const) : (['roadmap', 'satellite', 'terrain'] as const);
  for (const mapType of mapTypes) {
    const source = await googleImagery({ ...common, id: `live-${mapType}`, mapType });
    await tiles(source, GOOGLE_TILES);
    const copyright = await source.viewportCopyright({
      zoom: 10,
      westDeg: 12.3,
      southDeg: 41.8,
      eastDeg: 12.6,
      northDeg: 42,
    });
    if (!copyright) throw new Error(`no viewport copyright for ${mapType}`);
  }
  report.ran.push(`Google Map Tiles API 2D (${mapTypes.join(', ')})`);
  if (eea) {
    const reason = 'not available to EEA billing accounts (Map Tiles API EEA terms, ADR 0031)';
    report.skipped.push({ endpoint: 'Google Map Tiles API 2D satellite', reason });
    report.skipped.push({ endpoint: 'Google Map Tiles API Street View', reason });
    return;
  }
  const streetView = await googleStreetView(common);
  const pano = await streetView.metadata({ latitudeDeg: 41.8902, longitudeDeg: 12.4922, radiusMeters: 100 });
  if (!pano) throw new Error('no Street View panorama near the Colosseum');
  for (const [x, y] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ])
    await streetView.tile(pano.panoId, 1, x ?? 0, y ?? 0);
  report.ran.push('Google Map Tiles API Street View');
}

async function openStreetMap(fetchImpl: typeof fetch, report: LiveReport, url?: string): Promise<void> {
  const source = openStreetMapImagery({
    appName: 'VibeGlobe live adapter test',
    appUrl: 'https://github.com/SimoneRecchia/VibeGlobe',
    fetch: fetchImpl,
    warn: () => undefined,
    ...(url ? { url } : {}),
  });
  await tiles(source, [
    [0, 0, 0],
    [5, 17, 11],
    [10, 545, 373],
  ]);
  report.ran.push('OpenStreetMap public raster servers (3 tiles)');
}

/** Options of {@link runLiveSuite}; tests point the endpoints at fixtures. */
export interface LiveOptions {
  readonly googleApiKey?: string;
  /** The billing region of the key's account (default 'eea', the owner's: `GOOGLE_BILLING_REGION`). */
  readonly googleBillingRegion?: 'eea' | 'other';
  readonly fetch?: typeof fetch;
  readonly googleBaseUrl?: string;
  readonly osmUrl?: string;
}

/** Runs every allowed live endpoint once; never throws, the report says what happened. */
export async function runLiveSuite(options: LiveOptions): Promise<LiveReport> {
  const report: LiveReport = { ran: [], skipped: [...NEVER_LIVE], failed: [], requests: {} };
  const fetchImpl = guardedFetch(options.fetch ?? ((input, init) => fetch(input, init)), report);
  const steps: [string, (() => Promise<void>) | undefined, string][] = [
    [
      'Google Map Tiles API',
      options.googleApiKey
        ? () =>
            google(
              options.googleApiKey ?? '',
              fetchImpl,
              report,
              options.googleBillingRegion ?? 'eea',
              options.googleBaseUrl,
            )
        : undefined,
      'GOOGLE_MAPS_API_KEY is not set: the Google live tests did not run (the fixture suites did)',
    ],
    ['OpenStreetMap public servers', () => openStreetMap(fetchImpl, report, options.osmUrl), ''],
  ];
  for (const [endpoint, run, why] of steps) {
    if (!run) {
      report.skipped.push({ endpoint, reason: why });
      continue;
    }
    if (report.stoppedBy) return report;
    try {
      await run();
    } catch (error) {
      if (report.stoppedBy) return report;
      report.failed.push({ endpoint, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const key = process.env['GOOGLE_MAPS_API_KEY'];
  const region = process.env['GOOGLE_BILLING_REGION'] === 'other' ? 'other' : 'eea';
  const report = await runLiveSuite(key ? { googleApiKey: key, googleBillingRegion: region } : {});
  for (const line of report.ran) console.log(`ran      ${line}`);
  for (const s of report.skipped) console.log(`skipped  ${s.endpoint}: ${s.reason}`);
  for (const f of report.failed) console.log(`FAILED   ${f.endpoint}: ${f.reason}`);
  console.log(`requests ${JSON.stringify(report.requests)}`);
  if (report.stoppedBy) console.error(`STOPPED  ${report.stoppedBy}`);
  process.exitCode = report.failed.length > 0 || report.stoppedBy ? 1 : 0;
}
