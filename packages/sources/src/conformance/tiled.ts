import type { ImagerySource, TileCoord, TransportResult } from '@vibeglobe/core';
import type { DescribedImagerySource } from '../metadata.js';
import { type CheckResult, check, faultyFetch, type FaultMode, sameBytes } from './support.js';

/**
 * The shared conformance suite of tiled sources (F223): metadata, tile addressing, coverage, zoom range, error
 * handling (404, 500, timeouts, corrupted payloads), cancellation, attribution and provider-profile enforcement. It
 * needs no test framework: a test (or a custom adapter package) runs it and asserts every check passed.
 */
export interface TiledConformanceSubject {
  /** Names the subject in the report. */
  readonly name: string;
  /** Builds the source on top of `fetchImpl`, which serves the recorded fixture (with faults when a check asks). */
  create(fetchImpl: typeof fetch): ImagerySource | Promise<ImagerySource>;
  /** Serves the recorded fixture of the service. */
  readonly fixture: typeof fetch;
  /** Tiles the fixture has, with their expected bytes when the adapter passes them through unchanged. */
  readonly tiles: readonly { readonly coord: TileCoord; readonly bytes?: Uint8Array | undefined }[];
  /** Tiles inside the levels and coverage that the fixture has no data for. */
  readonly missing?: readonly TileCoord[];
  /**
   * When the source talks to the network: for each tile ('per-tile', default), or only once while it opens
   * ('on-open', a package downloaded whole); network faults are injected accordingly.
   */
  readonly network?: 'per-tile' | 'on-open';
  /** Tiles outside the coverage, which must never be requested. */
  readonly outside?: readonly TileCoord[];
  /** Extra provider-profile checks: each returns a failure message, or undefined when the rule holds. */
  readonly profileChecks?: readonly ((
    source: DescribedImagerySource,
    requests: readonly string[],
  ) => string | undefined)[];
}

const TIMEOUTS = { firstByteMs: 2_000, totalMs: 4_000 };
const SHORT_TIMEOUTS = { firstByteMs: 40, totalMs: 80 };

/** Runs one request through the source's own transport; resolves once `done` was called, and counts the calls. */
async function fetchTile(
  source: ImagerySource,
  coord: TileCoord,
  timeouts = TIMEOUTS,
  abortAfterMs?: number,
): Promise<{ result: TransportResult | 'noData'; calls: number; threw: boolean }> {
  const request = source.request(coord, { url: '', hostIndex: 0 });
  if (request === 'noData' || request === 'unknown') return { result: 'noData', calls: 0, threw: false };
  return new Promise((resolve) => {
    let calls = 0;
    let first: TransportResult | undefined;
    try {
      const abort = source.transport.start({ ...request }, timeouts, (result) => {
        calls++;
        first ??= result;
        // Wait a little for a second, forbidden call before reporting.
        setTimeout(() => resolve({ result: first ?? result, calls, threw: false }), 20);
      });
      if (abortAfterMs === 0) {
        abort();
        abort();
      } else if (abortAfterMs !== undefined) {
        setTimeout(() => {
          abort();
          abort();
        }, abortAfterMs);
      }
    } catch {
      resolve({ result: { kind: 'network-error' }, calls, threw: true });
    }
  });
}

function metadataChecks(source: ImagerySource): CheckResult[] {
  const described = source as Partial<DescribedImagerySource>;
  const levelsOk =
    Number.isInteger(source.minLevel) && Number.isInteger(source.maxLevel) && source.minLevel <= source.maxLevel;
  return [
    check('metadata', 'has a non-empty id', source.id.length > 0),
    check('metadata', 'declares a tiling scheme and reference system', source.tiling.crs.length > 0),
    check('zoom range', 'declares integer levels with min ≤ max', levelsOk, `${source.minLevel}–${source.maxLevel}`),
    check('metadata', 'declares a positive tile size', source.tileSizePx > 0, String(source.tileSizePx)),
    check('metadata', 'declares a pixel ratio of 1 or 2', source.pixelRatio === 1 || source.pixelRatio === 2),
    check(
      'attribution',
      'declares its attribution',
      Array.isArray(described.attribution) && described.attribution.every((a) => a.text.length > 0),
    ),
    check('provider profile', 'declares a provider profile', described.profile !== undefined),
  ];
}

function rangeChecks(source: ImagerySource, subject: TiledConformanceSubject): CheckResult[] {
  const sample = subject.tiles[0]?.coord ?? { root: 0, level: source.minLevel, x: 0, y: 0 };
  const deeper = { ...sample, level: source.maxLevel + 1, x: sample.x * 2, y: sample.y * 2 };
  const out: CheckResult[] = [
    check('zoom range', 'never requests a tile above its maximum level', source.request(deeper, blank()) === 'noData'),
  ];
  if (source.minLevel > 0) {
    const coarser = { root: 0 as const, level: source.minLevel - 1, x: 0, y: 0 };
    out.push(
      check(
        'zoom range',
        'never requests a tile below its minimum level',
        source.request(coarser, blank()) === 'noData',
      ),
    );
  }
  for (const coord of subject.outside ?? [])
    out.push(
      check(
        'coverage',
        `never requests ${key(coord)} outside its coverage`,
        source.request(coord, blank()) === 'noData',
      ),
    );
  return out;
}

async function addressingChecks(source: ImagerySource, subject: TiledConformanceSubject): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const tile of subject.tiles) {
    const { result, calls } = await fetchTile(source, tile.coord);
    const ok = result !== 'noData' && result.kind === 'ok' && result.bytes.byteLength > 0;
    const bytesOk = ok && (tile.bytes === undefined || sameBytes(result.bytes, tile.bytes));
    out.push(
      check(
        'addressing',
        `delivers ${key(tile.coord)} with the expected bytes`,
        bytesOk && calls === 1,
        describe(result),
      ),
    );
  }
  for (const coord of subject.missing ?? []) {
    const { result } = await fetchTile(source, coord);
    out.push(check('addressing', `reports ${key(coord)} as no data`, isNoData(result), describe(result)));
  }
  return out;
}

/** For sources that download their data when they open: each fault makes opening fail with a descriptive error. */
async function openFaultChecks(subject: TiledConformanceSubject): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const mode of ['404', '500', 'hang', 'corrupt'] as const) {
    let outcome: string;
    try {
      await subject.create(faultyFetch(subject.fixture, mode));
      outcome = 'opened';
    } catch (error) {
      outcome = error instanceof Error && error.message.length > 0 ? 'refused' : `threw ${String(error)}`;
    }
    out.push(
      check(
        'error handling',
        `a ${mode} answer while opening gives a descriptive error`,
        outcome === 'refused',
        outcome,
      ),
    );
  }
  return out;
}

/** Faults and cancellation of a source that talks to the network only while it opens. */
async function onOpenChecks(subject: TiledConformanceSubject, coord: TileCoord): Promise<CheckResult[]> {
  const source = await subject.create(subject.fixture);
  const aborted = await fetchTile(source, coord, TIMEOUTS, 0);
  const cancelled = aborted.result !== 'noData' && aborted.result.kind === 'aborted';
  return [
    ...(await openFaultChecks(subject)),
    check(
      'cancellation',
      'an aborted request ends once as aborted',
      cancelled && once(aborted),
      describe(aborted.result),
    ),
  ];
}

async function faultChecks(subject: TiledConformanceSubject): Promise<CheckResult[]> {
  const coord = subject.tiles[0]?.coord;
  if (!coord) return [check('error handling', 'has a fixture tile to test faults with', false)];
  if (subject.network === 'on-open') return onOpenChecks(subject, coord);
  const run = async (mode: FaultMode, timeouts = TIMEOUTS, abortAfterMs?: number) => {
    // The service works while the source opens (capabilities, archive header), then starts failing.
    const service: { faulty?: typeof fetch } = {};
    const source = await subject.create((input, init) => (service.faulty ?? subject.fixture)(input, init));
    service.faulty = faultyFetch(subject.fixture, mode);
    return fetchTile(source, coord, timeouts, abortAfterMs);
  };
  const out: CheckResult[] = [];
  const notFound = await run('404');
  out.push(
    check(
      'error handling',
      'a 404 answer is no data',
      isNoData(notFound.result) && once(notFound),
      describe(notFound.result),
    ),
  );
  const failing = await run('500');
  const transient = failing.result !== 'noData' && failing.result.kind === 'status' && failing.result.status === 500;
  out.push(
    check(
      'error handling',
      'a 500 answer is reported as a retryable status',
      transient && once(failing),
      describe(failing.result),
    ),
  );
  const slow = await run('hang', SHORT_TIMEOUTS);
  const timedOut = slow.result !== 'noData' && slow.result.kind === 'timeout';
  out.push(
    check('error handling', 'a request without an answer times out', timedOut && once(slow), describe(slow.result)),
  );
  const corrupt = await run('corrupt');
  out.push(check('error handling', 'a corrupted payload never throws and ends once', !corrupt.threw && once(corrupt)));
  const aborted = await run('hang', TIMEOUTS, 0);
  const cancelled = aborted.result !== 'noData' && aborted.result.kind === 'aborted';
  out.push(
    check(
      'cancellation',
      'an aborted request ends once as aborted',
      cancelled && once(aborted),
      describe(aborted.result),
    ),
  );
  return out;
}

async function profileChecks(subject: TiledConformanceSubject): Promise<CheckResult[]> {
  const requests: string[] = [];
  const recording: typeof fetch = (input, init) => {
    requests.push(input instanceof Request ? input.url : String(input));
    return subject.fixture(input, init);
  };
  const source = (await subject.create(recording)) as DescribedImagerySource;
  for (const tile of subject.tiles) await fetchTile(source, tile.coord);
  const profile = source.profile as DescribedImagerySource['profile'] | undefined;
  // A source without a profile already failed the metadata check.
  if (!profile) return [];
  const out: CheckResult[] = [];
  if (profile.maxConcurrentRequests !== undefined) {
    const perHost = source.maxRequestsPerHost;
    const within = perHost !== undefined && perHost <= profile.maxConcurrentRequests;
    out.push(check('provider profile', 'keeps per-host concurrency within the profile limit', within, `${perHost}`));
  }
  if (profile.requiredAttribution) {
    const required = profile.requiredAttribution.text;
    out.push(
      check(
        'provider profile',
        'shows the attribution the profile requires',
        (source.attribution ?? []).some((a) => a.text.includes(required)),
      ),
    );
  }
  for (const rule of subject.profileChecks ?? []) {
    const failure = rule(source, requests);
    out.push(check('provider profile', failure ?? 'meets a provider rule', failure === undefined));
  }
  return out;
}

/** Runs the tiled-source suite against a subject and returns every check with its outcome. */
export async function runTiledConformance(subject: TiledConformanceSubject): Promise<CheckResult[]> {
  const source = await subject.create(subject.fixture);
  const results = [
    ...metadataChecks(source),
    ...rangeChecks(source, subject),
    ...(await addressingChecks(source, subject)),
    ...(await faultChecks(subject)),
    ...(await profileChecks(subject)),
  ];
  return results.map((r) => ({ ...r, subject: subject.name }));
}

function blank(): { url: string; hostIndex: number } {
  return { url: '', hostIndex: 0 };
}

function key(coord: TileCoord): string {
  return `${coord.level}/${coord.x}/${coord.y}`;
}

function once(run: { calls: number; result: TransportResult | 'noData' }): boolean {
  return run.result === 'noData' || run.calls === 1;
}

function isNoData(result: TransportResult | 'noData'): boolean {
  if (result === 'noData') return true;
  if (result.kind === 'ok') return result.bytes.byteLength === 0;
  return result.kind === 'status' && (result.status === 404 || result.status === 410 || result.status === 204);
}

function describe(result: TransportResult | 'noData'): string {
  if (result === 'noData') return 'noData';
  if (result.kind === 'ok') return `ok ${result.bytes.byteLength} bytes`;
  return result.kind === 'status' ? `status ${result.status}` : result.kind;
}
