/**
 * @packageDocumentation
 * Persistent cache, network modes, offline packages, connectivity and bandwidth logic.
 * @module @vibeglobe/offline
 */
export { createOffline } from './offline-engine.js';
export type {
  Offline,
  OfflineEvents,
  OfflineOptions,
  OfflineSettings,
  PackageReader,
  ServeEvent,
} from './offline-engine.js';
export type { TieredSourceOptions, PackageTile } from './tiered-source.js';
export { DEFAULT_HEURISTIC_MAX_AGE_MS, freshnessOf } from './cache-policy.js';
export type { CacheHeaders, Freshness, SourceCachePolicy } from './cache-policy.js';
export { indexedDbStore, DEFAULT_CACHE_BYTES } from './idb-store.js';
export type { IndexedDbStoreOptions } from './idb-store.js';
export { workerStore } from './worker-store.js';
export type { WorkerStoreOptions } from './worker-store.js';
export { memoryStore } from './memory-store.js';
export type { MemoryStoreOptions } from './memory-store.js';
export { defaultNetworkPolicy } from './policy.js';
export type { PolicyInputs } from './policy.js';
export { SwitchBoard, ALL_ON } from './switches.js';
export type { HealthCheckTiming } from './connectivity.js';
export { requestPersistence } from './persistence.js';
export type { PersistenceResult } from './persistence.js';
export { runCacheStoreContract } from './contract/cache-store-contract.js';
export { runNetworkPolicyContract } from './contract/network-policy-contract.js';
export type { ContractResult } from './contract/cache-store-contract.js';
export { createPackageManager } from './packages/package-manager.js';
export type {
  InstalledPackage,
  LocalPackage,
  PackageManager,
  PackageManagerOptions,
  PackageStorageUsage,
} from './packages/package-manager.js';
export { createManifest } from './packages/create-manifest.js';
export type { ManifestInput } from './packages/create-manifest.js';
export { PackageError, validateManifest } from './packages/manifest.js';
export type {
  PackageAttribution,
  PackageErrorCode,
  PackageFileEntry,
  PackageManifest,
  PackageSourceEntry,
} from './packages/manifest.js';
export type { BoundsDeg, PackageArea, PolygonDeg } from './packages/area.js';
export type { BuildReport, PackageRequest, PackageRequestSource } from './packages/builder.js';
export type { InstallOptions, InstallProgress } from './packages/installer.js';
export type { ArchiveAdapters } from './packages/reader.js';
export type {
  CachedTile,
  CacheStore,
  Connectivity,
  LoadingSwitch,
  LoadingSwitches,
  NetworkMode,
  NetworkPolicy,
  PolicyDecision,
  PolicyRequest,
  ProviderRules,
  RequestPurpose,
  StorageUsage,
  SwitchScope,
  TierCounters,
} from './types.js';
