import type { AbortHandle, ImagerySource, TileCoord, TileRequest, TimeoutsMs, TransportResult } from '@vibeglobe/core';
import { freshnessOf, type SourceCachePolicy } from './cache-policy.js';
import { endpointOf } from './connectivity.js';
import { fetchTile, type FetchOutcome } from './network-fetch.js';
import type { CachedTile, PolicyDecision, ProviderRules, TierCounters } from './types.js';

/** A tile read from an offline package. */
export interface PackageTile {
  readonly bytes: ArrayBuffer;
  readonly contentType: string;
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
  count(sourceId: string, tier: keyof TierCounters): void;
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
}

/** How long a tile that cannot be loaded while offline is held before the engine is told to ask again. */
const OFFLINE_HOLD_MS = 500;

/** The cache key of a tile of a source. */
export function tileKey(sourceId: string, coord: TileCoord): string {
  const root = coord.root === 0 ? '' : `r${coord.root}-`;
  return `${encodeURIComponent(sourceId)}/${root}${coord.level}/${coord.x}/${coord.y}`;
}

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
    if (stored && stored.freshUntilMs > Date.now()) {
      this.context.count(id, 'persistent');
      return okOf(stored);
    }
    if (decision.readPackages) {
      const tile = await this.context.readPackage(id, coord, signal).catch(() => undefined);
      if (tile) {
        this.context.count(id, 'package');
        return { kind: 'ok', bytes: tile.bytes, contentType: tile.contentType };
      }
    }
    const endpoint = endpointOf(url);
    if (decision.useNetwork && this.context.reachable(endpoint)) {
      const outcome = await fetchTile(this.context.fetch, url, timeouts, signal, stored);
      const result = this.afterFetch(outcome, key, stored, decision, endpoint);
      if (result) return result;
    }
    if (stored) {
      // Expired but unreachable: a stale tile beats a hole.
      this.context.count(id, 'persistent');
      return okOf(stored);
    }
    return this.miss(decision);
  }

  /** The result of a download, or undefined when the endpoint gave no usable answer. */
  private afterFetch(
    outcome: FetchOutcome,
    key: string,
    stored: CachedTile | undefined,
    decision: PolicyDecision,
    endpoint: string,
  ): TransportResult | undefined {
    const id = this.source.id;
    switch (outcome.kind) {
      case 'ok': {
        this.context.reportSuccess(endpoint);
        this.context.count(id, 'network');
        this.write(key, decision, outcome.headers, { bytes: outcome.bytes, contentType: outcome.contentType });
        return { kind: 'ok', bytes: outcome.bytes, contentType: outcome.contentType };
      }
      case 'not-modified': {
        this.context.reportSuccess(endpoint);
        if (!stored) return { kind: 'status', status: 502, retryAfterMs: undefined };
        this.context.count(id, 'revalidated');
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
        // While the endpoint still counts as reachable the failure goes to the engine, which backs off (F315); once a
        // health check finds it unreachable the request falls back to stale tiles or waits (F298).
        if (stored || !this.context.reachable(endpoint)) return undefined;
        return { kind: outcome.kind === 'timeout' ? 'timeout' : 'network-error' };
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
    return { kind: 'aborted' };
  }
}

function okOf(tile: CachedTile): TransportResult {
  return { kind: 'ok', bytes: tile.bytes, contentType: tile.contentType };
}
