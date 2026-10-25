// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type {
  AbortHandle,
  Attribution,
  TileSource,
  TileCoord,
  TileRequest,
  TimeoutsMs,
  TransportResult,
} from '@vibeglobe/core';
import { freshnessOf, type SourceCachePolicy } from './cache-policy.js';
import { endpointOf } from './connectivity.js';
import { fetchTile, type FetchOutcome } from './network-fetch.js';
import type { CachedTile, PolicyDecision, ProviderRules, TierCounters } from './types.js';

/** A tile read from an offline package. */
export interface PackageTile {
  readonly bytes: ArrayBuffer;
  readonly contentType: string;
  /** The package and version it came from, as `id@version`. */
  readonly packageId: string;
}

/** What a wrapped source needs from the engine around it (supplied by `createOffline`). */
export interface TierContext {
  decide(sourceId: string, layerId: string): PolicyDecision;
  /** Whether tiles around the view of this source (in this layer) may load ahead: the prefetch switch in effect. */
  prefetch(sourceId: string, layerId: string): boolean;
  readonly store: {
    get(key: string): Promise<CachedTile | undefined>;
    put(key: string, tile: CachedTile): void;
  };
  readPackage(sourceId: string, coord: TileCoord, signal: AbortSignal): Promise<PackageTile | undefined>;
  /** Makes an endpoint known to the health checks, with a tile URL it serves (a source may spread tiles over hosts). */
  addEndpoint(endpoint: string, probeUrl: string): void;
  /** False while the endpoint is known to be unreachable. */
  reachable(endpoint: string): boolean;
  reportSuccess(endpoint: string): void;
  reportFailure(endpoint: string): void;
  /** Resolves when connectivity or the mode changes, after a check of `endpoint` when given, or after `maxMs`. */
  waitForChange(maxMs: number, endpoint?: string): Promise<void>;
  /** The longest a triggered health check takes to finish, its wait for the least interval between checks included. */
  readonly longestCheckMs: number;
  /** True where offline-only mode is in effect for the source in its layer. */
  offlineOnly(sourceId: string, layerId: string): boolean;
  /** Counts changes of connectivity, mode or switches: a miss is worth retrying only after one (KB-190). */
  changes(): number;
  count(sourceId: string, tier: keyof TierCounters, coord?: TileCoord, packageId?: string): void;
  /** The credit a package's tiles of a source carry (F306, KB-189): one object per package and source, or none. */
  packageCredit(sourceId: string, packageId: string): Attribution | undefined;
  readonly fetch: typeof fetch;
}

/** Options of a wrapped source. */
export interface TieredSourceOptions {
  /** The layer the source belongs to, for per-layer switches (default: the source id). */
  readonly layerId?: string;
  /** The provider's rules; a profile can only switch features off. */
  readonly rules?: ProviderRules;
  /** Per-source cache settings, which can only shorten what the headers allow (F277). */
  readonly cachePolicy?: SourceCachePolicy;
  /**
   * How expired tiles are revalidated (F278): `conditional` sends If-None-Match and If-Modified-Since, which a
   * cross-origin host must allow in its CORS headers; `refetch` downloads again and keeps the stored tile when the ETag
   * is unchanged. Default: conditional on the page's own origin, refetch elsewhere.
   */
  readonly revalidation?: 'conditional' | 'refetch';
}

/** How long a tile that cannot be loaded while offline is held before the engine is told to ask again. */
const OFFLINE_HOLD_MS = 500;
/**
 * How long a tile asked for again with nothing changed since its last miss is held: a change of connectivity or mode
 * hands it back at once, so this only bounds a request nothing wakes. Handing it back every 500 ms kept the engine
 * asking for the whole outage (KB-190).
 */
const REPEATED_MISS_HOLD_MS = 60_000;
/** Misses remembered per source; more are forgotten, at worst costing one more short hold each. */
const MAX_REMEMBERED_MISSES = 4096;

/** The cache key of a tile of a source. */
export function tileKey(sourceId: string, coord: TileCoord): string {
  const root = coord.root === 0 ? '' : `r${coord.root}-`;
  return `${encodeURIComponent(sourceId)}/${root}${coord.level}/${coord.x}/${coord.y}`;
}

const FAILED_NETWORK: TransportResult = { kind: 'network-error' };
const FAILED_TIMEOUT: TransportResult = { kind: 'timeout' };
/** How long a failed download waits beyond the health check's time limit before the failure counts (M8 #5a). */
const CHECK_MARGIN_MS = 1000;

const NO_HEADERS = { cacheControl: null, expires: null, date: null, etag: null, lastModified: null };

const ABORTED: TransportResult = { kind: 'aborted' };

const NOT_FOUND: TransportResult = { kind: 'status', status: 404, retryAfterMs: undefined };

let wrapperCount = 0;

/**
 * Wraps a source so that each of its tiles comes from the first tier that holds it: the persistent cache, the offline
 * packages, then the network, each allowed or not by the policy; downloads fill the persistent cache (F272). The engine's
 * own GPU and RAM tiers sit above, unchanged. The source keeps its id, levels and coverage.
 */
export function tieredSource(source: TileSource, context: TierContext, options: TieredSourceOptions = {}): TileSource {
  const wrapper = ++wrapperCount;
  const layerId = options.layerId ?? source.id;
  const scratch: TileRequest = { url: '', hostIndex: 0 };
  const coordOf = (url: string): TileCoord | undefined => {
    const [root, level, x, y] = url.split('/').slice(-4).map(Number);
    if (level === undefined || x === undefined || y === undefined || (root !== 0 && root !== 1 && root !== 2))
      return undefined;
    return { root, level, x, y };
  };
  const loader = new TileLoader(source, context, options, layerId);
  return {
    ...source,
    // The engine's memory reuse and prefetch follow the mode, the switches and the provider at every frame (F281–F285,
    // F290): 1 keeps tiles in memory, 2 prefetches (`LOAD_KEEP_IN_MEMORY`, `LOAD_PREFETCH` of `@vibeglobe/core`).
    loadingFlags: () =>
      (context.decide(source.id, layerId).keepInMemory ? 1 : 0) | (context.prefetch(source.id, layerId) ? 2 : 0),
    transport: {
      start(request: TileRequest, timeouts: TimeoutsMs, done: (result: TransportResult) => void): AbortHandle {
        const coord = coordOf(request.url);
        const real = coord ? source.request(coord, scratch) : 'noData';
        if (!coord || real === 'noData' || real === 'unknown') {
          queueMicrotask(() => done(NOT_FOUND));
          return () => undefined;
        }
        return loader.start(coord, real.url, timeouts, done);
      },
    },
    request(coord: TileCoord, out: TileRequest): TileRequest | 'noData' | 'unknown' {
      // Availability not known yet stays unknown: a request now would read as no data for good (KB-157).
      const real = source.request(coord, out);
      if (real === 'noData' || real === 'unknown') return real;
      // The tile's own host, so the engine keeps each host's request limits for the wrapped source too (KB-156).
      const host = /^[a-z][a-z0-9+.-]*:\/\/([^/]+)/i.exec(real.url)?.[1] ?? 'local';
      out.url = `vibeglobe-tile://${host}/${String(wrapper)}/${coord.root}/${coord.level}/${coord.x}/${coord.y}`;
      return out;
    },
  };
}

class TileLoader {
  /** The change count at each tile's last miss, by tile key (KB-190). */
  private readonly misses = new Map<string, number>();

  constructor(
    private readonly source: TileSource,
    private readonly context: TierContext,
    private readonly options: TieredSourceOptions,
    private readonly layerId: string,
  ) {}

  start(coord: TileCoord, url: string, timeouts: TimeoutsMs, done: (result: TransportResult) => void): AbortHandle {
    const controller = new AbortController();
    let settled = false;
    const finish = (result: TransportResult): void => {
      if (settled) return;
      settled = true;
      done(result);
    };
    this.load(coord, url, timeouts, controller.signal)
      .then((result) => finish(controller.signal.aborted ? { kind: 'aborted' } : result))
      .catch(() => finish(controller.signal.aborted ? { kind: 'aborted' } : { kind: 'network-error' }));
    return () => {
      if (settled) return;
      controller.abort();
      finish({ kind: 'aborted' });
    };
  }

  private async load(
    coord: TileCoord,
    url: string,
    timeouts: TimeoutsMs,
    signal: AbortSignal,
  ): Promise<TransportResult> {
    const id = this.source.id;
    const decision = this.context.decide(id, this.layerId);
    const key = tileKey(id, coord);
    const stored = decision.readPersistentCache ? await this.context.store.get(key).catch(() => undefined) : undefined;
    // A request the engine aborted meanwhile delivers nothing, so no tier counts it (TB-03).
    if (signal.aborted) return ABORTED;
    if (stored && this.fresh(stored)) {
      this.context.count(id, 'persistent', coord);
      return okOf(stored);
    }
    if (decision.readPackages) {
      const tile = await this.context.readPackage(id, coord, signal).catch(() => undefined);
      if (signal.aborted) return ABORTED;
      if (tile) {
        this.context.count(id, 'package', coord, tile.packageId);
        // The package's credit is listed while this tile is drawn, and no longer (F306, KB-189).
        const attribution = this.context.packageCredit(id, tile.packageId);
        return {
          kind: 'ok',
          bytes: tile.bytes,
          contentType: tile.contentType,
          cached: true,
          ...(attribution ? { attribution } : {}),
        };
      }
    }
    const endpoint = endpointOf(url);
    if (decision.useNetwork) this.context.addEndpoint(endpoint, url);
    if (decision.useNetwork && this.context.reachable(endpoint)) {
      const outcome = this.ownTransport(url)
        ? await this.viaTransport(url, timeouts, signal)
        : await fetchTile(this.context.fetch, url, timeouts, signal, this.conditional(url) ? stored : undefined);
      if (signal.aborted) return ABORTED;
      const result = this.afterFetch(outcome, key, stored, decision, endpoint, coord);
      if (result !== FAILED_NETWORK && result !== FAILED_TIMEOUT) return result;
      // No usable answer: wait for the health check this triggered. An outage then never reaches the engine as a
      // failure (which would make it probe the host one request at a time, slowing cached and packaged tiles too);
      // a failure on a reachable endpoint does, and the engine backs off (F298, F315).
      if (!stored) {
        await this.context.waitForChange(this.context.longestCheckMs + CHECK_MARGIN_MS, endpoint);
        if (this.context.reachable(endpoint) && !signal.aborted) return result;
      }
    }
    if (stored) {
      // Expired but unreachable: a stale tile beats a hole.
      this.context.count(id, 'persistent', coord);
      return okOf(stored);
    }
    return this.miss(decision, key);
  }

  /**
   * True when tiles must be downloaded by the adapter's own transport (TB-01): it signs requests or holds a session
   * (`transportRequired`), or its URLs are not plain HTTP (archive pseudo URLs). Its answers carry no cache headers.
   */
  private ownTransport(url: string): boolean {
    return (this.source as { transportRequired?: boolean }).transportRequired === true || !/^https?:/.test(url);
  }

  /** Downloads through the adapter's transport, as a fetch outcome without headers. */
  private viaTransport(url: string, timeouts: TimeoutsMs, signal: AbortSignal): Promise<FetchOutcome> {
    return new Promise((resolve) => {
      const abort = this.source.transport.start({ url, hostIndex: 0 }, timeouts, (result) => {
        signal.removeEventListener('abort', abort);
        resolve(result.kind === 'ok' ? { ...result, headers: NO_HEADERS } : result);
      });
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  /** Fresh by its headers and by the source's own limit, which applies to tiles stored before it was set (F277). */
  private fresh(stored: CachedTile): boolean {
    const now = Date.now();
    const maxAgeMs = this.options.cachePolicy?.maxAgeMs;
    return stored.freshUntilMs > now && (maxAgeMs === undefined || stored.storedAtMs + maxAgeMs > now);
  }

  private conditional(url: string): boolean {
    if (this.options.revalidation) return this.options.revalidation === 'conditional';
    const page = (globalThis as { location?: { origin?: string } }).location?.origin;
    return page !== undefined && endpointOf(url) === page;
  }

  /** The result of a download, or undefined when the endpoint gave no usable answer. */
  private afterFetch(
    outcome: FetchOutcome,
    key: string,
    stored: CachedTile | undefined,
    decision: PolicyDecision,
    endpoint: string,
    coord: TileCoord,
  ): TransportResult {
    const id = this.source.id;
    switch (outcome.kind) {
      case 'ok': {
        this.context.reportSuccess(endpoint);
        this.context.count(
          id,
          stored?.etag !== undefined && outcome.headers.etag === stored.etag ? 'revalidated' : 'network',
          coord,
        );
        this.write(key, decision, outcome.headers, { bytes: outcome.bytes, contentType: outcome.contentType });
        const timing = outcome.timing;
        return {
          kind: 'ok',
          bytes: outcome.bytes,
          contentType: outcome.contentType,
          // The network's own timings for the bandwidth estimate (F300).
          ...(timing && !timing.cached
            ? { waitMs: timing.waitMs, transferMs: timing.transferMs, endAgoMs: timing.endAgoMs }
            : {}),
        };
      }
      case 'not-modified': {
        this.context.reportSuccess(endpoint);
        if (!stored) return { kind: 'status', status: 502, retryAfterMs: undefined };
        this.context.count(id, 'revalidated', coord);
        this.write(key, decision, outcome.headers, stored);
        return okOf(stored);
      }
      case 'status':
        this.context.reportSuccess(endpoint);
        return outcome;
      case 'aborted':
        return { kind: 'aborted' };
      case 'portal':
      case 'network-error':
      case 'timeout':
        this.context.reportFailure(endpoint);
        return outcome.kind === 'timeout' ? FAILED_TIMEOUT : FAILED_NETWORK;
    }
  }

  private write(
    key: string,
    decision: PolicyDecision,
    headers: Parameters<typeof freshnessOf>[0],
    tile: { bytes: ArrayBuffer; contentType: string; etag?: string; lastModified?: string },
  ): void {
    if (!decision.writePersistentCache) return;
    const now = Date.now();
    const freshness = freshnessOf(headers, now, {
      respectCacheHeaders: this.options.rules?.respectCacheHeaders ?? false,
      ...(this.options.cachePolicy ? { policy: this.options.cachePolicy } : {}),
    });
    if (!freshness.storable) return;
    const etag = headers.etag ?? tile.etag;
    const lastModified = headers.lastModified ?? tile.lastModified;
    this.context.store.put(key, {
      bytes: tile.bytes.slice(0),
      contentType: tile.contentType,
      storedAtMs: now,
      freshUntilMs: freshness.freshUntilMs,
      ...(etag ? { etag } : {}),
      ...(lastModified ? { lastModified } : {}),
    });
  }

  /**
   * No tier has the tile. In offline-only mode it never will: no data. Otherwise the network is down or not allowed
   * for now: hold the request briefly, then tell the engine to ask again (an abort, not a failure), so the tile loads
   * once connectivity returns without spending the engine's retries (F298, F299).
   */
  private async miss(decision: PolicyDecision, key: string): Promise<TransportResult> {
    if (this.context.offlineOnly(this.source.id, this.layerId) || !decision.useNetwork) return NOT_FOUND;
    this.context.count(this.source.id, 'offlineMisses');
    // Asked again with nothing changed since its last miss: wait for a change instead (KB-190).
    const changes = this.context.changes();
    const repeated = this.misses.get(key) === changes;
    if (this.misses.size >= MAX_REMEMBERED_MISSES) this.misses.clear();
    this.misses.set(key, changes);
    await this.context.waitForChange(repeated ? REPEATED_MISS_HOLD_MS : OFFLINE_HOLD_MS);
    // Not a failure: a transient error would make the engine probe the host with one request at a time, which would
    // also slow the tiles the cache and the packages hold.
    return { kind: 'aborted' };
  }
}

/** A tile from the persistent cache or a package: local, so it says nothing about the link (F300). */
function okOf(tile: CachedTile): TransportResult {
  return { kind: 'ok', bytes: tile.bytes, contentType: tile.contentType, cached: true };
}
