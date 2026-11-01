// The opt-in live run of the source adapters (F223): `npm run test:live-sources` runs the conformance checks against
// real public endpoints only where the provider's terms allow automated testing, reports every endpoint it skipped and
// why, and stops at the first quota error: the OpenStreetMap public servers, at the low volume ADR 0032 allows.
import { pathToFileURL } from 'node:url';
import { openStreetMapImagery, type DescribedImagerySource } from '@vibeglobe/sources';

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

/** Endpoints whose terms do not allow automated testing, or that have no public endpoint: never contacted. */
const NEVER_LIVE: readonly { endpoint: string; reason: string }[] = [
  {
    endpoint: 'WMTS, WMS',
    reason: 'no public service whose terms allow automated testing is configured; recorded capabilities only',
  },
  { endpoint: 'PMTiles, MBTiles', reason: 'self-hosted package formats: fixtures only' },
  { endpoint: 'vector formats', reason: 'documents, not services: fixtures only' },
];

/** A fetch that counts requests per host and records a quota answer, which stops the run. */
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
  readonly fetch?: typeof fetch;
  readonly osmUrl?: string;
}

/** Runs every allowed live endpoint once; never throws, the report says what happened. */
export async function runLiveSuite(options: LiveOptions): Promise<LiveReport> {
  const report: LiveReport = { ran: [], skipped: [...NEVER_LIVE], failed: [], requests: {} };
  const fetchImpl = guardedFetch(options.fetch ?? ((input, init) => fetch(input, init)), report);
  const steps: [string, (() => Promise<void>) | undefined, string][] = [
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
  const report = await runLiveSuite({});
  for (const line of report.ran) console.log(`ran      ${line}`);
  for (const s of report.skipped) console.log(`skipped  ${s.endpoint}: ${s.reason}`);
  for (const f of report.failed) console.log(`FAILED   ${f.endpoint}: ${f.reason}`);
  console.log(`requests ${JSON.stringify(report.requests)}`);
  if (report.stoppedBy) console.error(`STOPPED  ${report.stoppedBy}`);
  process.exitCode = report.failed.length > 0 || report.stoppedBy ? 1 : 0;
}
