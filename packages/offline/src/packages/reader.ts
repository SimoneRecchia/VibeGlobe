// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { TileSource, TileCoord, TransportResult } from '@vibeglobe/core';
import type { PackageReader } from '../offline-engine.js';
import type { PackageTile } from '../tiered-source.js';
import { tileKey } from '../tiered-source.js';
import { sha256Hex } from './integrity.js';
import type { PackageAttribution, PackageFileEntry, PackageManifest } from './manifest.js';
import { httpChunkLoader, IntegrityError, verifyingFetch, type ChunkLoader } from './package-fetch.js';
import { type PackageStorage, versionKey } from './package-storage.js';

/**
 * The PMTiles and MBTiles adapters, passed in by the application: their signatures, reduced to what packages use.
 * `pmtilesImagery` (from `@vibeglobe/sources`) and `mbtilesImagery` (from `@vibeglobe/sources/mbtiles`) read raster
 * packages; packages of terrain or vector tiles need the variants that accept any content:
 * `(o) => pmtilesArchive(o, 'any')` from `@vibeglobe/sources` and `(o) => mbtilesArchive(o, 'any')` from
 * `@vibeglobe/sources/mbtiles`.
 */
export interface ArchiveAdapters {
  pmtiles(options: { id: string; archive: string; fetch: typeof fetch }): Promise<TileSource>;
  mbtiles(options: { id: string; package: string; fetch: typeof fetch }): Promise<TileSource>;
}

/** A package the reader serves tiles from: installed in browser storage, or on a LAN server (offline mode 1). */
export interface ActivePackage {
  readonly manifest: PackageManifest;
  readonly kind: 'archive' | 'tiles';
  /** Where its files are: browser storage, or next to its manifest URL. */
  readonly origin: 'stored' | { readonly baseUrl: string };
}

const READ_TIMEOUTS = { firstByteMs: 30_000, totalMs: 30_000 };

/** Reads tiles from active packages, newest first; corrupted or unreadable data reads as missing (F309, F310). */
export class PackageTileReader implements PackageReader {
  private packages: readonly ActivePackage[] = [];
  private readonly opened = new Map<string, Promise<TileSource | undefined>>();

  constructor(
    private readonly storage: PackageStorage,
    private readonly adapters: ArchiveAdapters | undefined,
    private readonly fetchImpl: typeof fetch,
    private readonly onCorrupt: (packageId: string, message: string) => void,
  ) {}

  /** Replaces the active packages; sources of packages no longer active are dropped. */
  setPackages(packages: readonly ActivePackage[]): void {
    this.packages = packages;
    const live = new Set(packages.flatMap((p) => p.manifest.files.map((f) => this.fileKey(p, f))));
    for (const key of this.opened.keys()) if (!live.has(key)) this.opened.delete(key);
  }

  /** The credit a package records for one of its sources (F306). */
  attribution(packageId: string, sourceId: string): PackageAttribution | undefined {
    const pkg = this.packages.find((p) => `${p.manifest.id}@${p.manifest.version}` === packageId);
    return pkg?.manifest.sources.find((s) => s.sourceId === sourceId)?.attribution;
  }

  /** The active packages. */
  active(): readonly ActivePackage[] {
    return this.packages;
  }

  /** The tile of a source from the first active package that holds it. */
  async read(sourceId: string, coord: TileCoord, signal: AbortSignal): Promise<PackageTile | undefined> {
    for (const pkg of this.packages) {
      const entry = pkg.manifest.sources.find(
        (s) => s.sourceId === sourceId && coord.level >= s.minLevel && coord.level <= s.maxLevel,
      );
      if (!entry) continue;
      const tile =
        pkg.kind === 'tiles'
          ? await this.readStoredTile(pkg, sourceId, coord)
          : await this.readArchive(pkg, entry.file, coord, signal);
      if (tile) return tile;
    }
    return undefined;
  }

  private async readStoredTile(
    pkg: ActivePackage,
    sourceId: string,
    coord: TileCoord,
  ): Promise<PackageTile | undefined> {
    const tile = await this.storage.tile(versionKey(pkg.manifest), tileKey(sourceId, coord));
    if (!tile) return undefined;
    if ((await sha256Hex(tile.bytes)) !== tile.sha256) {
      this.onCorrupt(pkg.manifest.id, `tile ${tileKey(sourceId, coord)} fails its SHA-256 check`);
      return undefined;
    }
    return {
      bytes: tile.bytes,
      contentType: tile.contentType,
      packageId: `${pkg.manifest.id}@${pkg.manifest.version}`,
    };
  }

  private async readArchive(
    pkg: ActivePackage,
    path: string,
    coord: TileCoord,
    signal: AbortSignal,
  ): Promise<PackageTile | undefined> {
    const file = pkg.manifest.files.find((f) => f.path === path);
    if (!file) return undefined;
    const source = await this.open(pkg, file);
    if (!source) return undefined;
    const request = source.request(coord, { url: '', hostIndex: 0 });
    if (request === 'noData' || request === 'unknown') return undefined;
    const result = await new Promise<TransportResult>((resolve) => {
      const abort = source.transport.start(request, READ_TIMEOUTS, resolve);
      signal.addEventListener('abort', abort, { once: true });
    });
    if (result.kind !== 'ok' || result.bytes.byteLength === 0) return undefined;
    return {
      bytes: result.bytes,
      contentType: result.contentType,
      packageId: `${pkg.manifest.id}@${pkg.manifest.version}`,
    };
  }

  private fileKey(pkg: ActivePackage, file: PackageFileEntry): string {
    const where = pkg.origin === 'stored' ? 'stored' : pkg.origin.baseUrl;
    return `${where}|${versionKey(pkg.manifest)}${file.path}`;
  }

  private open(pkg: ActivePackage, file: PackageFileEntry): Promise<TileSource | undefined> {
    const key = this.fileKey(pkg, file);
    let opened = this.opened.get(key);
    if (!opened) {
      const reads = { failed: false };
      opened = this.openArchive(pkg, file, reads).catch((error: unknown) => {
        // A server that did not answer is not a corrupted package: the next read opens it again.
        if (reads.failed) {
          this.opened.delete(key);
          return undefined;
        }
        this.onCorrupt(
          pkg.manifest.id,
          `${file.path} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      });
      this.opened.set(key, opened);
    }
    return opened;
  }

  /** Opens a package file; `reads.failed` tells when a chunk read failed for another reason than its integrity. */
  private async openArchive(
    pkg: ActivePackage,
    file: PackageFileEntry,
    reads: { failed: boolean },
  ): Promise<TileSource> {
    if (!this.adapters) throw new Error('no PMTiles or MBTiles adapter was given to the package manager');
    const prefix = versionKey(pkg.manifest);
    const loader: ChunkLoader =
      pkg.origin === 'stored'
        ? async (index) => {
            const chunk = await this.storage.chunk(prefix, file.path, index);
            if (!chunk) throw new IntegrityError(`chunk ${index} of ${file.path} is missing from storage`, index);
            return chunk.arrayBuffer();
          }
        : httpChunkLoader(this.fetchImpl, new URL(file.path, pkg.origin.baseUrl).href, file);
    const watched: ChunkLoader = (index, signal) =>
      loader(index, signal).catch((error: unknown) => {
        if (!(error instanceof IntegrityError)) reads.failed = true;
        throw error;
      });
    const fetchImpl = verifyingFetch(file, watched, (error) => this.onCorrupt(pkg.manifest.id, error.message));
    const id = `package:${prefix}${file.path}`;
    const url = `https://vibeglobe.package/${encodeURIComponent(prefix)}${encodeURIComponent(file.path)}`;
    return file.format === 'pmtiles'
      ? this.adapters.pmtiles({ id, archive: url, fetch: fetchImpl })
      : this.adapters.mbtiles({ id, package: url, fetch: fetchImpl });
  }
}
