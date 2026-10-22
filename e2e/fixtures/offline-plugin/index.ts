// An application's own persistent cache store and network policy for @vibeglobe/offline (F327): written against the
// package's public interfaces only, outside packages/, and attached through `createOffline({ store, policy })`.
import type { CachedTile, CacheStore, NetworkPolicy, PolicyDecision, PolicyRequest } from '@vibeglobe/offline';

/**
 * A store in a Map, least recently used first, with its own size limit.
 *
 * @public (run through the contracts by e2e/offline-network.spec.ts)
 */
export function mapStore(maxBytes: number, counters: Record<string, number>): CacheStore {
  const tiles = new Map<string, CachedTile>();
  const size = (): number => [...tiles.values()].reduce((sum, tile) => sum + tile.bytes.byteLength, 0);
  return {
    get(key) {
      counters['gets'] = (counters['gets'] ?? 0) + 1;
      const tile = tiles.get(key);
      if (tile) {
        tiles.delete(key);
        tiles.set(key, tile);
      }
      return Promise.resolve(tile);
    },
    put(key, tile) {
      counters['puts'] = (counters['puts'] ?? 0) + 1;
      if (tile.bytes.byteLength > maxBytes) return Promise.resolve('quota');
      tiles.delete(key);
      tiles.set(key, { ...tile, bytes: tile.bytes.slice(0) });
      for (const oldest of tiles.keys()) {
        if (size() <= maxBytes) break;
        tiles.delete(oldest);
      }
      return Promise.resolve('stored');
    },
    delete(key) {
      tiles.delete(key);
      return Promise.resolve();
    },
    deletePrefix(prefix) {
      const keys = [...tiles.keys()].filter((key) => key.startsWith(prefix));
      for (const key of keys) tiles.delete(key);
      return Promise.resolve(keys.length);
    },
    usage() {
      return Promise.resolve({ bytes: size(), quotaBytes: maxBytes });
    },
    close() {
      tiles.clear();
    },
  };
}

/**
 * A policy that keeps every source online and cached, except sources whose id starts with `live-`, never stored.
 *
 * @public (run through the contracts by e2e/offline-network.spec.ts)
 */
export function liveSourcesPolicy(counters: Record<string, number>): NetworkPolicy {
  return {
    resolve(request: PolicyRequest): PolicyDecision {
      counters['decisions'] = (counters['decisions'] ?? 0) + 1;
      const live = request.sourceId.startsWith('live-');
      return {
        useNetwork: true,
        readPackages: !live,
        readPersistentCache: !live,
        writePersistentCache: !live,
        keepInMemory: true,
      };
    },
  };
}

/** The store and the policy with shared counters, as the harness page attaches them. */
export function createPlugin(): { store: CacheStore; policy: NetworkPolicy; counters: Record<string, number> } {
  const counters: Record<string, number> = {};
  return { store: mapStore(4 * 1024 * 1024, counters), policy: liveSourcesPolicy(counters), counters };
}
