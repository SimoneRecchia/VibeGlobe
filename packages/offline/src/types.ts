/**
 * Public types of the offline engine (docs/plan/api.md, "Loading policy and caches" and "Offline packages"; ADR 0029).
 */

/** Where tiles may come from: online only, offline only (never the network), or both (the default). */
export type NetworkMode = 'online' | 'offline' | 'hybrid';

/** The loading features; each is on by default and can be switched off globally, per source or per layer. */
export interface LoadingSwitches {
  /** Tiles are kept in browser storage across sessions. */
  persistentCache: boolean;
  /** Tiles stay in RAM and GPU memory after they leave the screen (the engine's memory tiers). */
  memoryReuse: boolean;
  /** Tiles around the view and flight destinations load ahead. */
  prefetch: boolean;
  /** The source's tiles may be included in offline packages. */
  offlinePackaging: boolean;
}

/** The names of the loading switches. */
export type LoadingSwitch = keyof LoadingSwitches;

/** Where a switch setting applies: everywhere, to one source, or to one layer. */
export interface SwitchScope {
  readonly sourceId?: string;
  readonly layerId?: string;
}

/**
 * What a provider's terms allow (docs/plan/api.md, `ProviderProfile`). Structurally the subset of the source adapters'
 * `ProviderProfile` that this package enforces, so adapters' profiles can be passed as they are. A profile can only
 * switch features off (PLAN.md).
 */
export interface ProviderRules {
  readonly id: string;
  /** Loading features the provider forbids. */
  readonly forbids: ReadonlySet<LoadingSwitch>;
  /** Reuse responses only while their HTTP cache headers allow it. */
  readonly respectCacheHeaders: boolean;
}

/** The connectivity the engine has measured: every endpoint reachable, some, or none. */
export type Connectivity = 'online' | 'offline' | 'degraded';

/** A tile kept in a {@link CacheStore}. */
export interface CachedTile {
  readonly bytes: ArrayBuffer;
  readonly contentType: string;
  /** When the tile was stored or last revalidated (epoch milliseconds). */
  readonly storedAtMs: number;
  /** Until when it may be reused without revalidation (epoch milliseconds); `storedAtMs` when it must be revalidated. */
  readonly freshUntilMs: number;
  /** The validators of the response, for revalidation with If-None-Match and If-Modified-Since. */
  readonly etag?: string;
  readonly lastModified?: string;
}

/** Bytes used, and the limit when one applies. */
export interface StorageUsage {
  readonly bytes: number;
  readonly quotaBytes: number | undefined;
}

/**
 * A persistent tile store (docs/plan/api.md, `CacheStore`): a public extension point, so applications can plug in
 * their own. Keys are opaque strings. Implementations never throw for a full store: `put` resolves `'quota'` instead.
 */
export interface CacheStore {
  get(key: string): Promise<CachedTile | undefined>;
  /** Stores a tile; resolves `'quota'` when the browser or the store refused it for lack of space. */
  put(key: string, tile: CachedTile): Promise<'stored' | 'quota'>;
  delete(key: string): Promise<void>;
  /** Removes every key that starts with `prefix` (all keys with an empty prefix); resolves how many were removed. */
  deletePrefix(prefix: string): Promise<number>;
  usage(): Promise<StorageUsage>;
  /** Releases the store's resources. */
  close(): void;
}

/** Why a tile was requested. */
export type RequestPurpose = 'visible' | 'prefetch' | 'package';

/** What one request may use (docs/plan/api.md, `NetworkPolicy.resolve`). */
export interface PolicyDecision {
  useNetwork: boolean;
  readPackages: boolean;
  readPersistentCache: boolean;
  writePersistentCache: boolean;
  keepInMemory: boolean;
}

/** The request a {@link NetworkPolicy} decides about. */
export interface PolicyRequest {
  readonly sourceId: string;
  readonly layerId: string;
  readonly purpose: RequestPurpose;
}

/**
 * Decides, per request, which tiers may be used and whether the network may be touched (docs/plan/api.md). A public
 * extension point; {@link defaultNetworkPolicy} resolves the mode, the switches and the provider rules.
 */
export interface NetworkPolicy {
  resolve(request: PolicyRequest): PolicyDecision;
}

/** Counters of where tiles came from, per tier (F272). */
export interface TierCounters {
  /** Tiles served from the persistent cache without touching the network. */
  persistent: number;
  /** Stored tiles revalidated with the server and reused after a 304. */
  revalidated: number;
  /** Tiles read from offline packages. */
  package: number;
  /** Tiles downloaded. */
  network: number;
  /** Requests answered with no tile while offline (the engine keeps an ancestor or the base). */
  offlineMisses: number;
}
