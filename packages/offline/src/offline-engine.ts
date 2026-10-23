import type { Attribution, TileCoord, TileSource } from '@vibeglobe/core';
import { ConnectivityMonitor, endpointOf, type HealthCheckTiming } from './connectivity.js';
import { DEFAULT_CACHE_BYTES, indexedDbStore } from './idb-store.js';
import { workerStore } from './worker-store.js';
import { memoryStore } from './memory-store.js';
import { requestPersistence, type PersistenceResult } from './persistence.js';
import { defaultNetworkPolicy } from './policy.js';
import { SwitchBoard } from './switches.js';
import type { PackageAttribution } from './packages/manifest.js';
import { tieredSource, type PackageTile, type TieredSourceOptions } from './tiered-source.js';
import type {
  CacheStore,
  Connectivity,
  LoadingSwitch,
  LoadingSwitches,
  NetworkMode,
  NetworkPolicy,
  ProviderRules,
  SwitchScope,
  TierCounters,
} from './types.js';

/** Events of an offline engine. */
export interface OfflineEvents {
  /** The measured connectivity changed (F298, F299). */
  'connectivity-change': { connectivity: Connectivity; unreachable: readonly string[] };
  /** The browser deleted stored data (F275): the persistent cache, packages, or both. */
  'storage-lost': { cache: boolean; packages: readonly string[]; reason: string };
  /** The network mode changed. */
  'mode-change': { mode: NetworkMode };
  /** A problem the engine worked around (a full store, missing storage); reported once per kind. */
  warning: { code: 'quota' | 'storage-unavailable' | 'profile-rule'; message: string };
}

/** Reads tiles of installed or LAN-served packages; supplied by the package manager. */
export interface PackageReader {
  read(sourceId: string, coord: TileCoord, signal: AbortSignal): Promise<PackageTile | undefined>;
  /** The credit a package records for one of its sources (F306). */
  attribution?(packageId: string, sourceId: string): PackageAttribution | undefined;
}

/** Options of {@link createOffline}. */
export interface OfflineOptions {
  /** The network mode (default hybrid, F271). */
  readonly mode?: NetworkMode;
  /** Global loading switches (default all on, F271). */
  readonly switches?: Partial<LoadingSwitches>;
  /**
   * The persistent tile store: IndexedDB in the cache worker by default, `'main-thread'` for IndexedDB on the page, a
   * custom {@link CacheStore} (F327), or `'memory'` where nothing may be kept across sessions.
   */
  readonly store?: CacheStore | 'memory' | 'main-thread';
  /** Size limit of the default persistent cache, in bytes (default 512 MiB, F274). */
  readonly cacheBytes?: number;
  /** A custom policy replacing the built-in resolution of mode, switches and provider rules (F327). */
  readonly policy?: NetworkPolicy;
  /** Health-check timing (F297). */
  readonly healthChecks?: HealthCheckTiming;
  /** The `fetch` used for tiles and health checks; the global one by default. */
  readonly fetch?: typeof fetch;
  /** Called for every tile a wrapped source delivers, with the tier it came from (debug overlays, tests). */
  readonly onServe?: (event: ServeEvent) => void;
}

/** A tile delivered by a wrapped source and the tier it came from. */
export interface ServeEvent {
  readonly sourceId: string;
  readonly coord: TileCoord;
  readonly tier: keyof TierCounters;
  /** The package it was read from, for the package tier. */
  readonly packageId?: string;
}

/** The effective settings (F271). */
export interface OfflineSettings {
  readonly mode: NetworkMode;
  readonly switches: LoadingSwitches;
}

/** An offline engine: network modes, loading switches, the persistent cache and connectivity for wrapped sources. */
export interface Offline {
  readonly mode: NetworkMode;
  /** Changes the network mode at runtime; new requests follow it at once (F290). */
  setMode(mode: NetworkMode): void;
  /** Sets loading switches globally, or for one source or layer (F290). */
  setSwitches(switches: Partial<LoadingSwitches>, scope?: SwitchScope): void;
  /** The mode and the global switches. */
  settings(): OfflineSettings;
  /** The switches in effect for a source (in a layer), with its provider's rules applied. */
  effectiveSwitches(sourceId: string, layerId?: string): LoadingSwitches;
  readonly connectivity: Connectivity;
  /**
   * Wraps a source (imagery, terrain or vector tiles, F328) so its tiles go through the persistent cache, packages and
   * network tiers (F272).
   */
  source<S extends TileSource>(source: S, options?: TieredSourceOptions): S;
  /** Where tiles came from, per source and in total. */
  stats(sourceId?: string): TierCounters;
  /** The persistent cache's use and limit. */
  cacheUsage(): Promise<{ bytes: number; quotaBytes: number | undefined }>;
  /** Removes cached tiles: of one source, or all. */
  clearCache(sourceId?: string): Promise<void>;
  /** Asks the browser to keep the engine's storage under storage pressure (F276). */
  requestPersistentStorage(): Promise<PersistenceResult>;
  /** Attaches the package reader (the package manager does this). */
  setPackageReader(reader: PackageReader | undefined): void;
  on<E extends keyof OfflineEvents>(event: E, handler: (payload: OfflineEvents[E]) => void): () => void;
  /** Reports a loss detected outside the cache store (the package manager). */
  reportLoss(loss: OfflineEvents['storage-lost']): void;
  destroy(): void;
}

const CACHE_FLAG = 'vibeglobe-offline:cache';

function readFlag(): string | null {
  try {
    return globalThis.localStorage?.getItem(CACHE_FLAG) ?? null;
  } catch {
    return null;
  }
}

function writeFlag(value: string): void {
  try {
    globalThis.localStorage?.setItem(CACHE_FLAG, value);
  } catch {
    // Blocked storage: eviction is then reported only while the page is open.
  }
}

const zeroCounters = (): TierCounters => ({ persistent: 0, revalidated: 0, package: 0, network: 0, offlineMisses: 0 });

/** Creates an offline engine (ADR 0033). Its sources plug into the engine through the frozen source contract. */
export function createOffline(options: OfflineOptions = {}): Offline {
  return new OfflineEngine(options);
}

class OfflineEngine implements Offline {
  private currentMode: NetworkMode;
  private readonly switches = new SwitchBoard();
  private readonly rules = new Map<string, ProviderRules>();
  private readonly policy: NetworkPolicy;
  private readonly store: CacheStore;
  private readonly monitor: ConnectivityMonitor;
  private readonly handlers = new Map<keyof OfflineEvents, Set<(payload: never) => void>>();
  private readonly counters = new Map<string, TierCounters>();
  private readonly warned = new Set<string>();
  private waiters: (() => void)[] = [];
  private packageReader: PackageReader | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly onServe: OfflineOptions['onServe'];
  private cacheMarked = false;
  /** Switches the application set on globally: a source registered later whose profile forbids one is warned about. */
  private readonly enabledGlobally = new Set<LoadingSwitch>();
  /** The packages each source's tiles were read from: their credits join the source's (F306). */
  private readonly servedPackages = new Map<string, Set<string>>();

  constructor(options: OfflineOptions) {
    this.currentMode = options.mode ?? 'hybrid';
    if (options.switches) this.setSwitches(options.switches);
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.onServe = options.onServe;
    this.policy =
      options.policy ??
      defaultNetworkPolicy({
        mode: () => this.currentMode,
        switches: this.switches,
        rules: (id) => this.rules.get(id),
      });
    this.store = this.createStore(options);
    this.monitor = new ConnectivityMonitor({
      ...options.healthChecks,
      fetch: this.fetchImpl,
      enabled: () => this.currentMode !== 'offline',
      onChange: (connectivity, unreachable) => {
        this.wake();
        this.emit('connectivity-change', { connectivity, unreachable });
      },
    });
    // Only the built-in store outlives the page; a memory or custom store is not checked.
    if (options.store === undefined || options.store === 'main-thread') void this.checkCacheEviction();
    else this.cacheMarked = true;
  }

  get mode(): NetworkMode {
    return this.currentMode;
  }

  get connectivity(): Connectivity {
    return this.monitor.connectivity;
  }

  setMode(mode: NetworkMode): void {
    if (mode === this.currentMode) return;
    this.currentMode = mode;
    this.wake();
    if (mode !== 'offline') this.monitor.checkAll();
    this.emit('mode-change', { mode });
  }

  setSwitches(switches: Partial<LoadingSwitches>, scope?: SwitchScope): void {
    this.switches.set(switches, scope);
    const enabled = (Object.keys(switches) as LoadingSwitch[]).filter((name) => switches[name] === true);
    for (const name of enabled) {
      if (scope?.sourceId === undefined && scope?.layerId === undefined) this.enabledGlobally.add(name);
      for (const [sourceId, rules] of this.rules)
        if (scope?.sourceId === undefined || scope.sourceId === sourceId) this.refuseForbidden(sourceId, rules, name);
    }
    this.wake();
  }

  settings(): OfflineSettings {
    return { mode: this.currentMode, switches: this.switches.globalSwitches() };
  }

  effectiveSwitches(sourceId: string, layerId = sourceId): LoadingSwitches {
    return this.switches.effective(sourceId, layerId, this.rules.get(sourceId));
  }

  source<S extends TileSource>(source: S, options: TieredSourceOptions = {}): S {
    const rules = options.rules ?? (source as unknown as { profile?: ProviderRules }).profile;
    if (rules) {
      this.rules.set(source.id, rules);
      for (const name of this.enabledGlobally) this.refuseForbidden(source.id, rules, name);
    }
    this.registerEndpoint(source);
    const wrapped = { ...source, ...tieredSource(source, this.context(), { ...options, ...(rules ? { rules } : {}) }) };
    // Read whenever the engine lists credits: the source's own (live, a provider may change them, F258), then each
    // package its tiles came from (F306).
    Object.defineProperty(wrapped, 'attribution', {
      enumerable: true,
      get: () => this.creditsOf(source.id, (source as { attribution?: readonly Attribution[] }).attribution ?? []),
    });
    return wrapped as S;
  }

  /** A source's credits followed by those of the packages that served its tiles, each text once. */
  private creditsOf(sourceId: string, own: readonly Attribution[]): readonly Attribution[] {
    const packages = this.servedPackages.get(sourceId);
    if (!packages || !this.packageReader?.attribution) return own;
    const credits = [...own];
    for (const packageId of packages) {
      const credit = this.packageReader.attribution(packageId, sourceId);
      if (credit && !credits.some((c) => c.text === credit.text)) credits.push(credit);
    }
    return credits;
  }

  stats(sourceId?: string): TierCounters {
    if (sourceId !== undefined) return { ...(this.counters.get(sourceId) ?? zeroCounters()) };
    const total = zeroCounters();
    for (const counters of this.counters.values())
      for (const tier of Object.keys(total) as (keyof TierCounters)[]) total[tier] += counters[tier];
    return total;
  }

  cacheUsage(): Promise<{ bytes: number; quotaBytes: number | undefined }> {
    return this.store.usage().catch(() => ({ bytes: 0, quotaBytes: undefined }));
  }

  async clearCache(sourceId?: string): Promise<void> {
    await this.store.deletePrefix(sourceId === undefined ? '' : `${encodeURIComponent(sourceId)}/`);
    // A cache the application emptied itself is no eviction to report on the next start (F275).
    const usage = await this.store.usage().catch(() => undefined);
    if (usage?.bytes === 0) this.markCache(false);
  }

  requestPersistentStorage(): Promise<PersistenceResult> {
    return requestPersistence();
  }

  setPackageReader(reader: PackageReader | undefined): void {
    this.packageReader = reader;
    this.wake();
  }

  on<E extends keyof OfflineEvents>(event: E, handler: (payload: OfflineEvents[E]) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler as (payload: never) => void);
    return () => set.delete(handler as (payload: never) => void);
  }

  reportLoss(loss: OfflineEvents['storage-lost']): void {
    this.emit('storage-lost', loss);
  }

  destroy(): void {
    this.monitor.destroy();
    this.store.close();
    this.wake();
    this.handlers.clear();
  }

  private createStore(options: OfflineOptions): CacheStore {
    if (options.store === 'memory') return memoryStore({ maxBytes: options.cacheBytes ?? DEFAULT_CACHE_BYTES });
    if (options.store && options.store !== 'main-thread') return options.store;
    const settings = {
      ...(options.cacheBytes === undefined ? {} : { maxBytes: options.cacheBytes }),
      onLost: (reason: string) => this.emit('storage-lost', { cache: true, packages: [], reason }),
    };
    // IndexedDB in the cache worker keeps reads and writes off the main thread (F273).
    return options.store === undefined && typeof Worker !== 'undefined'
      ? workerStore(settings)
      : indexedDbStore(settings);
  }

  private registerEndpoint(source: TileSource): void {
    const probe = { url: '', hostIndex: 0 };
    const root = { root: 0 as const, level: source.minLevel, x: 0, y: 0 };
    if (source.request(root, probe) === 'noData' || !/^https?:/.test(probe.url)) return;
    this.monitor.addEndpoint(endpointOf(probe.url), probe.url);
  }

  private context(): Parameters<typeof tieredSource>[1] {
    return {
      decide: (sourceId, layerId) => this.policy.resolve({ sourceId, layerId, purpose: 'visible' }),
      prefetch: (sourceId, layerId) => this.effectiveSwitches(sourceId, layerId).prefetch,
      store: {
        get: (key) => this.store.get(key),
        put: (key, tile) => void this.put(key, tile),
      },
      readPackage: (sourceId, coord, signal) =>
        this.packageReader ? this.packageReader.read(sourceId, coord, signal) : Promise.resolve(undefined),
      addEndpoint: (endpoint, probeUrl) => {
        if (/^https?:/.test(probeUrl)) this.monitor.addEndpoint(endpoint, probeUrl);
      },
      reachable: (endpoint) => this.monitor.state(endpoint) === 'reachable',
      reportSuccess: (endpoint) => this.monitor.reportSuccess(endpoint),
      reportFailure: (endpoint) => this.monitor.reportFailure(endpoint),
      waitForChange: (maxMs) =>
        new Promise<void>((resolve) => {
          const waiter = (): void => {
            clearTimeout(timer);
            resolve();
          };
          // A wait that times out leaves the list, which would otherwise grow for the whole outage.
          const timer = setTimeout(() => {
            this.waiters = this.waiters.filter((w) => w !== waiter);
            resolve();
          }, maxMs);
          this.waiters.push(waiter);
        }),
      offlineOnly: () => this.currentMode === 'offline',
      count: (sourceId, tier, coord, packageId) => {
        let counters = this.counters.get(sourceId);
        if (!counters) this.counters.set(sourceId, (counters = zeroCounters()));
        counters[tier]++;
        if (packageId !== undefined) {
          let packages = this.servedPackages.get(sourceId);
          if (!packages) this.servedPackages.set(sourceId, (packages = new Set()));
          packages.add(packageId);
        }
        if (coord) this.onServe?.({ sourceId, coord, tier, ...(packageId === undefined ? {} : { packageId }) });
      },
      fetch: this.fetchImpl,
    };
  }

  private async put(key: string, tile: Parameters<CacheStore['put']>[1]): Promise<void> {
    try {
      const result = await this.store.put(key, tile);
      if (result === 'quota')
        this.warn('quota', 'The persistent tile cache is full: older tiles are evicted, rendering continues.');
      else if (!this.cacheMarked) this.markCache(true);
    } catch (error) {
      this.warn('storage-unavailable', `The persistent tile cache is unavailable: ${String(error)}`);
    }
  }

  /** A cache that held tiles in an earlier session and is empty now was evicted by the browser (F275). */
  private async checkCacheEviction(): Promise<void> {
    if (readFlag() !== '1') return;
    const usage = await this.store.usage().catch(() => undefined);
    if (usage === undefined || usage.bytes > 0) {
      this.cacheMarked = usage !== undefined;
      return;
    }
    this.markCache(false);
    this.emit('storage-lost', {
      cache: true,
      packages: [],
      reason: 'the persistent cache was emptied between sessions',
    });
  }

  private markCache(filled: boolean): void {
    this.cacheMarked = filled;
    writeFlag(filled ? '1' : '0');
  }

  /** An application asked for a feature the source's provider forbids: it stays off, with one warning (F320). */
  private refuseForbidden(sourceId: string, rules: ProviderRules, name: LoadingSwitch): void {
    if (!rules.forbids.has(name)) return;
    this.warn(
      'profile-rule',
      `${name} stays off for source '${sourceId}': its provider profile '${rules.id}' forbids it`,
      `${sourceId}/${name}`,
    );
  }

  private warn(code: OfflineEvents['warning']['code'], message: string, key: string = code): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[vibeglobe/offline] ${message}`);
    this.emit('warning', { code, message });
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  private emit<E extends keyof OfflineEvents>(event: E, payload: OfflineEvents[E]): void {
    for (const handler of this.handlers.get(event) ?? []) (handler as (p: OfflineEvents[E]) => void)(payload);
  }
}
