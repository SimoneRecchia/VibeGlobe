// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { Offline } from '../offline-engine.js';
import { browserQuotaBytes, isPersisted, type PersistenceResult } from '../persistence.js';
import type { PackageArea } from './area.js';
import { buildPackage, estimateRequest, type BuildReport, type PackageRequest } from './builder.js';
import { completeRecord, installFiles, partialKey, type FileOrigin, type InstallOptions } from './installer.js';
import {
  DEFAULT_CHUNK_BYTES,
  PackageError,
  validateManifest,
  type PackageManifest,
  type PackageSourceEntry,
} from './manifest.js';
import { PackageStorage, type PackageRecord, versionKey } from './package-storage.js';
import { PackageTileReader, type ActivePackage, type ArchiveAdapters } from './reader.js';

/** An installed package as the management API lists it (F311). */
export interface InstalledPackage {
  readonly id: string;
  readonly version: string;
  readonly name: string | undefined;
  readonly area: PackageArea;
  readonly minLevel: number;
  readonly maxLevel: number;
  readonly sources: readonly PackageSourceEntry[];
  /** Every license of its sources. */
  readonly licenses: readonly string[];
  readonly bytes: number;
  readonly installedAtMs: number;
  readonly kind: 'archive' | 'tiles';
}

/** Local package files: the manifest and the files it lists, by path. */
export interface LocalPackage {
  readonly manifest: PackageManifest | Blob;
  readonly files: Readonly<Record<string, Blob>>;
}

/** Storage use (F313). */
export interface PackageStorageUsage {
  readonly packages: readonly { readonly id: string; readonly bytes: number }[];
  readonly cacheBytes: number;
  readonly totalBytes: number;
  /** The browser's quota for the origin, when it reports one. */
  readonly quotaBytes: number | undefined;
  readonly persisted: boolean;
}

/** Options of {@link createPackageManager}. */
export interface PackageManagerOptions {
  /** The PMTiles and MBTiles adapters of `@vibeglobe/sources` (`pmtilesImagery`, `mbtilesImagery`). */
  readonly adapters?: ArchiveAdapters;
  readonly fetch?: typeof fetch;
  readonly indexedDB?: IDBFactory;
  readonly database?: string;
  /** Where the list of what should be stored is kept between sessions, to detect eviction (F275). */
  readonly localStorage?: Pick<Storage, 'getItem' | 'setItem'>;
  /** Called when a package's data fails its checks while installed or read (F309). */
  readonly onIntegrityError?: (event: { packageId: string; message: string }) => void;
  /**
   * Called after a package was installed, updated or removed, with the engine sources whose tiles it holds: pass each
   * to `globe.reloadSource`, so a running globe drops the tiles it still holds from the old version (F279).
   */
  readonly onChange?: (event: { packageId: string; sourceIds: readonly string[] }) => void;
}

/** The package management API (docs/plan/api.md, `PackageManager`). */
export interface PackageManager {
  /** Resolves once installed packages are loaded and eviction is checked. */
  readonly ready: Promise<void>;
  list(): Promise<InstalledPackage[]>;
  estimate(request: PackageRequest): Promise<{ tiles: number; bytes: number }>;
  /** Installs from a manifest URL, from local files, or by downloading an area in the browser. */
  install(
    from: string | URL | LocalPackage | PackageRequest,
    options?: InstallOptions,
  ): Promise<InstalledPackage & { report?: BuildReport }>;
  /** Installs the newest version from the package's manifest URL; the old version's tiles are removed (F279). */
  update(id: string, options?: InstallOptions): Promise<InstalledPackage>;
  remove(id: string): Promise<void>;
  /** Reads a package from a LAN or static server without installing it (offline mode 1, F295). */
  addServedPackage(manifestUrl: string | URL): Promise<InstalledPackage>;
  removeServedPackage(id: string): void;
  storageUsage(): Promise<PackageStorageUsage>;
  requestPersistentStorage(): Promise<PersistenceResult>;
  destroy(): void;
}

const EXPECTED_KEY = 'vibeglobe-offline:packages';

function describe(record: PackageRecord): InstalledPackage {
  const { manifest } = record;
  return {
    id: manifest.id,
    version: manifest.version,
    name: manifest.name,
    area: manifest.area,
    minLevel: Math.min(...manifest.sources.map((s) => s.minLevel)),
    maxLevel: Math.max(...manifest.sources.map((s) => s.maxLevel)),
    sources: manifest.sources,
    licenses: [...new Set(manifest.sources.map((s) => s.license))],
    bytes: record.bytes,
    installedAtMs: record.installedAtMs,
    kind: record.kind,
  };
}

const isRequest = (from: unknown): from is PackageRequest =>
  typeof from === 'object' && from !== null && 'minLevel' in from && 'sources' in from && !('files' in from);

/** Creates the package manager of an offline engine; its packages become the engine's package tier (F311). */
export function createPackageManager(offline: Offline, options: PackageManagerOptions = {}): PackageManager {
  return new Manager(offline, options);
}

class Manager implements PackageManager {
  readonly ready: Promise<void>;
  private readonly storage: PackageStorage;
  private readonly reader: PackageTileReader;
  private readonly fetchImpl: typeof fetch;
  private installed: PackageRecord[] = [];
  private readonly served = new Map<string, ActivePackage>();

  constructor(
    private readonly offline: Offline,
    private readonly options: PackageManagerOptions,
  ) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    const factory = options.indexedDB ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB);
    this.storage = new PackageStorage(factory, options.database, (reason) => this.lost(reason));
    this.reader = new PackageTileReader(this.storage, options.adapters, this.fetchImpl, (packageId, message) =>
      options.onIntegrityError?.({ packageId, message }),
    );
    offline.setPackageReader(this.reader);
    this.ready = this.load(true);
  }

  async list(): Promise<InstalledPackage[]> {
    await this.ready;
    return this.installed.map(describe);
  }

  estimate(request: PackageRequest): Promise<{ tiles: number; bytes: number }> {
    return Promise.resolve(estimateRequest(request));
  }

  async install(
    from: string | URL | LocalPackage | PackageRequest,
    options: InstallOptions = {},
  ): Promise<InstalledPackage & { report?: BuildReport }> {
    await this.ready;
    if (isRequest(from)) return this.build(from, options);
    if (typeof from === 'string' || from instanceof URL) {
      const url = new URL(String(from), globalThis.location?.href).href;
      return this.installArchive(await this.fetchManifest(url), { baseUrl: url }, url, options);
    }
    const raw = from.manifest instanceof Blob ? JSON.parse(await from.manifest.text()) : from.manifest;
    return this.installArchive(validateManifest(raw), { files: from.files }, undefined, options);
  }

  async update(id: string, options: InstallOptions = {}): Promise<InstalledPackage> {
    await this.ready;
    const record = this.installed.find((r) => r.manifest.id === id);
    if (!record) throw new PackageError('not-installed', `package '${id}' is not installed`);
    if (!record.manifestUrl) throw new PackageError('invalid-manifest', `package '${id}' was not installed from a URL`);
    const manifest = await this.fetchManifest(record.manifestUrl);
    if (manifest.version === record.manifest.version) return describe(record);
    return this.installArchive(manifest, { baseUrl: record.manifestUrl }, record.manifestUrl, options);
  }

  async remove(id: string): Promise<void> {
    await this.ready;
    const record = this.installed.find((r) => r.manifest.id === id);
    if (!record) throw new PackageError('not-installed', `package '${id}' is not installed`);
    await this.storage.deleteData(versionKey(record.manifest));
    await this.storage.deleteRecord(id);
    await this.load(false);
    this.changed(record);
  }

  /** Tells the application which sources a package change affects (`onChange`). */
  private changed(record: PackageRecord): void {
    this.options.onChange?.({
      packageId: record.manifest.id,
      sourceIds: record.manifest.sources.map((s) => s.sourceId),
    });
  }

  async addServedPackage(manifestUrl: string | URL): Promise<InstalledPackage> {
    const url = new URL(String(manifestUrl), globalThis.location?.href).href;
    const manifest = await this.fetchManifest(url);
    // A served file is read in place, never hashed whole: without chunk hashes its reads could not be verified (F309).
    for (const file of manifest.files) {
      const chunks = Math.ceil(file.bytes / (file.chunkBytes ?? DEFAULT_CHUNK_BYTES));
      if (file.chunkSha256?.length !== chunks)
        throw new PackageError(
          'invalid-manifest',
          `${file.path} of '${manifest.id}' has no chunk hashes (chunkSha256) to verify its reads; build the manifest with createManifest`,
        );
    }
    this.served.set(manifest.id, { manifest, kind: 'archive', origin: { baseUrl: url } });
    this.activate();
    return describe(completeRecord(manifest, 'archive', 0, url));
  }

  removeServedPackage(id: string): void {
    this.served.delete(id);
    this.activate();
  }

  async storageUsage(): Promise<PackageStorageUsage> {
    await this.ready;
    const packages = this.installed.map((r) => ({ id: r.manifest.id, bytes: r.bytes }));
    const cacheBytes = (await this.offline.cacheUsage()).bytes;
    const packageBytes = packages.reduce((sum, p) => sum + p.bytes, 0);
    return {
      packages,
      cacheBytes,
      totalBytes: cacheBytes + packageBytes,
      quotaBytes: await browserQuotaBytes(),
      persisted: await isPersisted(),
    };
  }

  requestPersistentStorage(): Promise<PersistenceResult> {
    return this.offline.requestPersistentStorage();
  }

  destroy(): void {
    this.offline.setPackageReader(undefined);
    this.storage.close();
  }

  private async fetchManifest(url: string): Promise<PackageManifest> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { mode: 'cors', credentials: 'omit', cache: 'no-store' });
    } catch (error) {
      throw new PackageError(
        'download-failed',
        `the package manifest ${url} could not be downloaded (${String(error)})`,
      );
    }
    if (!response.ok)
      throw new PackageError('download-failed', `the package manifest ${url} answered HTTP ${response.status}`);
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new PackageError('invalid-manifest', `the package manifest ${url} is not JSON`);
    }
    return validateManifest(parsed);
  }

  private async installArchive(
    manifest: PackageManifest,
    origin: FileOrigin,
    manifestUrl: string | undefined,
    options: InstallOptions,
  ): Promise<InstalledPackage> {
    // Installing the installed version again re-verifies it; a failure must not delete the chunks it reads from.
    const installed = this.installed.some(
      (r) => r.manifest.id === manifest.id && r.manifest.version === manifest.version,
    );
    await this.storage.putRecord(
      { manifest, kind: 'archive', state: 'partial', installedAtMs: Date.now(), bytes: 0 },
      partialKey(manifest),
    );
    const verified = await installFiles(this.storage, manifest, origin, this.fetchImpl, options, installed);
    const bytes = verified.files.reduce((sum, f) => sum + f.bytes, 0);
    return this.commit(completeRecord(verified, 'archive', bytes, manifestUrl));
  }

  private async build(
    request: PackageRequest,
    options: InstallOptions,
  ): Promise<InstalledPackage & { report: BuildReport }> {
    const offline = this.offline;
    const { manifest, report } = await buildPackage(
      request,
      {
        storage: this.storage,
        fetch: this.fetchImpl,
        packagingAllowed: (sourceId, layerId) => offline.effectiveSwitches(sourceId, layerId).offlinePackaging,
        globalPackagingAllowed: () => offline.settings().switches.offlinePackaging,
      },
      options,
    );
    return { ...(await this.commit(completeRecord(manifest, 'tiles', report.bytes, undefined))), report };
  }

  /** Records a complete install and removes the version it replaces, so none of its tiles is read again (F279). */
  private async commit(record: PackageRecord): Promise<InstalledPackage> {
    const previous = this.installed.find((r) => r.manifest.id === record.manifest.id);
    await this.storage.putRecord(record);
    await this.storage.deleteRecord(partialKey(record.manifest));
    if (previous && previous.manifest.version !== record.manifest.version)
      await this.storage.deleteData(versionKey(previous.manifest));
    await this.load(false);
    this.changed(record);
    return describe(record);
  }

  private async load(checkEviction: boolean): Promise<void> {
    let records: PackageRecord[];
    try {
      records = await this.storage.records();
    } catch {
      // Storage that did not open (Safari's IndexedDB that never answers) lost nothing: no loss is reported, and the
      // list of packages that should exist is kept for the next start.
      return;
    }
    this.installed = records.filter((r) => r.state === 'complete').sort((a, b) => b.installedAtMs - a.installedAtMs);
    const now = this.installed.map((r) => `${r.manifest.id}@${r.manifest.version}`);
    if (checkEviction) {
      const expected = this.readExpected();
      const missing = expected.filter((key) => !now.includes(key)).map((key) => key.slice(0, key.lastIndexOf('@')));
      if (missing.length > 0)
        queueMicrotask(() =>
          this.offline.reportLoss({ cache: false, packages: missing, reason: 'packages missing at start-up' }),
        );
    }
    this.writeExpected(now);
    this.activate();
  }

  private activate(): void {
    const installed: ActivePackage[] = this.installed.map((r) => ({
      manifest: r.manifest,
      kind: r.kind,
      origin: 'stored',
    }));
    this.reader.setPackages([...installed, ...this.served.values()]);
  }

  private lost(reason: string): void {
    const packages = this.installed.map((r) => r.manifest.id);
    this.installed = [];
    this.writeExpected([]);
    this.activate();
    if (packages.length > 0) this.offline.reportLoss({ cache: false, packages, reason });
  }

  private storageApi(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
    try {
      return this.options.localStorage ?? globalThis.localStorage;
    } catch {
      return undefined;
    }
  }

  private readExpected(): string[] {
    try {
      const parsed = JSON.parse(this.storageApi()?.getItem(EXPECTED_KEY) ?? '[]') as unknown;
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      return [];
    }
  }

  private writeExpected(keys: string[]): void {
    try {
      this.storageApi()?.setItem(EXPECTED_KEY, JSON.stringify(keys));
    } catch {
      // Storage may be blocked; eviction is then reported only while the page is open.
    }
  }
}
