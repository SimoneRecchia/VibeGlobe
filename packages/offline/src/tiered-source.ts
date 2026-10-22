import type { AbortHandle, ImagerySource, TileCoord, TileRequest, TimeoutsMs, TransportResult } from '@vibeglobe/core';
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
  readonly store: {
    get(key: string): Promise<CachedTile | undefined>;
    put(key: string, tile: CachedTile): void;
  };
  readPackage(sourceId: string, coord: TileCoord, signal: AbortSignal): Promise<PackageTile | undefined>;
  /** False while the endpoint is known to be unreachable. */
  reachable(endpoint: string): boolean;
  reportSuccess(endpoint: string): void;
  reportFailure(endpoint: string): void;
  /** Resolves when connectivity or the mode changes, or after `maxMs`. */
  waitForChange(maxMs: number): Promise<void>;
  /** True in offline-only mode. */
  offlineOnly(): boolean;
  count(sourceId: string, tier: keyof TierCounters, coord?: TileCoord, packageId?: string): void;
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

/** The cache key of a tile of a source. */
export function tileKey(sourceId: string, coord: TileCoord): string {
  const root = coord.root === 0 ? '' : `r${coord.root}-`;
  return `${encodeURIComponent(sourceId)}/${root}${coord.level}/${coord.x}/${coord.y}`;
}

const FAILED_NETWORK: TransportResult = { kind: 'network-error' };
const FAILED_TIMEOUT: TransportResult = { kind: 'timeout' };
/** How long a failed download waits for the health check it triggered before the failure counts. */
const CHECK_WAIT_MS = 3000;

const NOT_FOUND: TransportResult = { kind: 'status', status: 404, retryAfterMs: undefined };

let wrapperCount = 0;

/**
 * Wraps a source so that each of its tiles comes from the first tier that holds it: the persistent cache, the offline
 * packages, then the network, each allowed or not by the policy; downloads fill the persistent cache (F272). The engine's
 * own GPU and RAM tiers sit above, unchanged. The source keeps its id, levels and coverage.
 */
export function tieredSource(
  source: ImagerySource,
  context: TierContext,
  options: TieredSourceOptions = {},
): ImagerySource {
  const prefix = `vibeglobe-tile:${++wrapperCount}/`;
  const layerId = options.layerId ?? source.id;
  const scratch: TileRequest = { url: '', hostIndex: 0 };
  const coordOf = (url: string): TileCoord | undefined => {
    const [root, level, x, y] = url.slice(prefix.length).split('/').map(Number);
    if (level === undefined || x === undefined || y === undefined || (root !== 0 && root !== 1 && root !== 2))
      return undefined;
    return { root, level, x, y };
  };
  const loader = new TileLoader(source, context, options, layerId);
  return {
    ...source,
    transport: {
      start(request: TileRequest, timeouts: TimeoutsMs, done: (result: TransportResult) => void): AbortHandle {
        const coord = coordOf(request.url);
        const real = coord ? source.request(coord, scratch) : 'noData';
        if (!coord || real === 'noData') {
          queueMicrotask(() => done(NOT_FOUND));
          return () => undefined;
        }
        return loader.start(coord, real.url, timeouts, done);
      },
    },
    request(coord: TileCoord, out: TileRequest): TileRequest | 'noData' {
      if (source.request(coord, out) === 'noData') return 'noData';
      out.url = `${prefix}${coord.root}/${coord.level}/${coord.x}/${coord.y}`;
      return out;
    },
  };
}

class TileLoader {
  constructor(
    private readonly source: ImagerySource,
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
    if (stored && this.fresh(stored)) {
      this.context.count(id, 'persistent', coord);
      return okOf(stored);
    }
    if (decision.readPackages) {
      const tile = await this.context.readPackage(id, coord, signal).catch(() => undefined);
      if (tile) {
        this.context.count(id, 'package', coord, tile.packageId);
        return { kind: 'ok', bytes: tile.bytes, contentType: tile.contentType };
      }
    }
    const endpoint = endpointOf(url);
    if (decision.useNetwork && this.context.reachable(endpoint)) {
      const outcome = await fetchTile(
        this.context.fetch,
        url,
        timeouts,
        signal,
        this.conditional(url) ? stored : undefined,
      );
      const result = this.afterFetch(outcome, key, stored, decision, endpoint, coord);
      if (result !== FAILED_NETWORK && result !== FAILED_TIMEOUT) return result;
      // No usable answer: wait for the health check this triggered. An outage then never reaches the engine as a
      // failure (which would make it probe the host one request at a time, slowing cached and packaged tiles too);
      // a failure on a reachable endpoint does, and the engine backs off (F298, F315).
      if (!stored) {
        await this.context.waitForChange(CHECK_WAIT_MS);
        if (this.context.reachable(endpoint) && !signal.aborted) return result;
      }
    }
    if (stored) {
      // Expired but unreachable: a stale tile beats a hole.
      this.context.count(id, 'persistent', coord);
      return okOf(stored);
    }
    return this.miss(decision);
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
        return { kind: 'ok', bytes: outcome.bytes, contentType: outcome.contentType };
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
  private async miss(decision: PolicyDecision): Promise<TransportResult> {
    if (this.context.offlineOnly() || !decision.useNetwork) return NOT_FOUND;
    this.context.count(this.source.id, 'offlineMisses');
    await this.context.waitForChange(OFFLINE_HOLD_MS);
    // Not a failure: a transient error would make the engine probe the host with one request at a time, which would
    // also slow the tiles the cache and the packages hold.
    return { kind: 'aborted' };
  }
}

function okOf(tile: CachedTile): TransportResult {
  return { kind: 'ok', bytes: tile.bytes, contentType: tile.contentType };
}
