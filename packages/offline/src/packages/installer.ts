import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  chunkHashes,
  partsOfRange,
  PMTILES_HEADER_BYTES,
  pmtilesLayout,
  sha256Hex,
  type PmtilesLayout,
} from './integrity.js';
import { DEFAULT_CHUNK_BYTES, PackageError, type PackageFileEntry, type PackageManifest } from './manifest.js';
import { httpChunkLoader, type ChunkLoader } from './package-fetch.js';
import { type PackageRecord, type PackageStorage, versionKey } from './package-storage.js';

/** Progress of an install or a build. */
export interface InstallProgress {
  readonly packageId: string;
  readonly loadedBytes: number;
  readonly totalBytes: number;
  /** Bytes skipped because an interrupted install had already stored them (F308). */
  readonly resumedBytes: number;
}

/** Options of an install. */
export interface InstallOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: InstallProgress) => void;
}

/** Where the files of a package come from: next to its manifest URL, or local files by path. */
export type FileOrigin = { readonly baseUrl: string } | { readonly files: Readonly<Record<string, Blob>> };

/** The storage key of the record of an install in progress. */
export function partialKey(manifest: Pick<PackageManifest, 'id' | 'version'>): string {
  return `partial:${manifest.id}@${manifest.version}`;
}

function loaderOf(origin: FileOrigin, entry: PackageFileEntry, fetchImpl: typeof fetch): ChunkLoader {
  if ('baseUrl' in origin) return httpChunkLoader(fetchImpl, new URL(entry.path, origin.baseUrl).href, entry);
  const file = origin.files[entry.path];
  if (!file) throw new PackageError('invalid-manifest', `the package file '${entry.path}' was not given`);
  if (file.size !== entry.bytes)
    throw new PackageError('integrity', `${entry.path}: ${file.size} bytes, the manifest says ${entry.bytes}`);
  const chunkBytes = entry.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  return (index) => file.slice(index * chunkBytes, (index + 1) * chunkBytes).arrayBuffer();
}

/** Describes a corrupted chunk with the archive parts it hits. */
function corruption(entry: PackageFileEntry, index: number, layout: PmtilesLayout | undefined): PackageError {
  const chunkBytes = entry.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const start = index * chunkBytes;
  const end = Math.min(entry.bytes, start + chunkBytes);
  const parts = entry.format === 'pmtiles' ? partsOfRange(layout, start, end).join(', ') : 'database pages';
  return new PackageError(
    'integrity',
    `${entry.path} is corrupted: bytes ${start}–${end - 1} (${parts}) fail their SHA-256 check`,
  );
}

/**
 * Downloads (or copies) and verifies the files of a package into browser storage, chunk by chunk (F309, F311).
 * Chunks already stored by an interrupted install of the same version are not fetched again (F308). Each chunk is
 * checked against the manifest's chunk hash, the whole file against its SHA-256, and a PMTiles header against its
 * layout; any other failure than a download cut by the network removes what was stored (unless `keepStored`: the same
 * version is installed and reads from those chunks) and throws a {@link PackageError} naming the file and the part hit.
 */
export async function installFiles(
  storage: PackageStorage,
  manifest: PackageManifest,
  origin: FileOrigin,
  fetchImpl: typeof fetch,
  options: InstallOptions,
  keepStored = false,
): Promise<PackageManifest> {
  const prefix = versionKey(manifest);
  const totalBytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
  const progress = { loadedBytes: 0, resumedBytes: 0 };
  const files: PackageFileEntry[] = [];
  try {
    for (const entry of manifest.files) {
      files.push(
        await installFile(storage, prefix, entry, loaderOf(origin, entry, fetchImpl), options, (bytes, resumed) => {
          progress.loadedBytes += bytes;
          if (resumed) progress.resumedBytes += bytes;
          options.onProgress?.({ packageId: manifest.id, totalBytes, ...progress });
        }),
      );
    }
  } catch (error) {
    // A download cut by the network keeps its verified chunks, so the next install resumes (F308).
    if (error instanceof PackageError && error.code !== 'download-failed') {
      // `keepStored`: the same version is installed and reads from these chunks.
      if (!keepStored) await storage.deleteData(prefix);
      await storage.deleteRecord(partialKey(manifest));
    }
    throw error;
  }
  return { ...manifest, files };
}

async function installFile(
  storage: PackageStorage,
  prefix: string,
  entry: PackageFileEntry,
  load: ChunkLoader,
  options: InstallOptions,
  advance: (bytes: number, resumed: boolean) => void,
): Promise<PackageFileEntry> {
  const chunkBytes = entry.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const count = Math.ceil(entry.bytes / chunkBytes);
  const stored = await storage.storedChunks(prefix, entry.path);
  let layout: PmtilesLayout | undefined;
  let head = new Uint8Array(0);
  const whole = sha256.create();
  for (let index = 0; index < count; index++) {
    options.signal?.throwIfAborted();
    const resumed = stored.has(index);
    const bytes = resumed
      ? await (await storage.chunk(prefix, entry.path, index))?.arrayBuffer()
      : await load(index, options.signal).catch((error: unknown) => {
          if (options.signal?.aborted) throw error;
          throw new PackageError(
            'download-failed',
            `${entry.path}: chunk ${index} could not be downloaded (${String(error)})`,
          );
        });
    if (!bytes) throw new PackageError('integrity', `${entry.path}: chunk ${index} is missing from storage`);
    const expected = entry.chunkSha256?.[index];
    if (expected !== undefined && (await sha256Hex(bytes)) !== expected) throw corruption(entry, index, layout);
    if (entry.format === 'pmtiles' && layout === undefined && head.length < PMTILES_HEADER_BYTES) {
      head = concat(head, new Uint8Array(bytes));
      if (head.length >= PMTILES_HEADER_BYTES || (index + 1) * chunkBytes >= entry.bytes) {
        const parsed = pmtilesLayout(head, entry.bytes);
        if (typeof parsed === 'string') throw new PackageError('integrity', `${entry.path} is corrupted: ${parsed}`);
        layout = parsed;
      }
    }
    whole.update(new Uint8Array(bytes));
    if (!resumed) await storage.putChunk(prefix, entry.path, index, new Blob([bytes]));
    advance(bytes.byteLength, resumed);
  }
  if (bytesToHex(whole.digest()) !== entry.sha256)
    throw new PackageError('integrity', `${entry.path} is corrupted: the file fails its SHA-256 check`);
  if (entry.chunkSha256) return entry;
  // Reads verify chunk by chunk: record the chunk hashes of a manifest that had only the whole file's.
  const chunks: Blob[] = [];
  for (let index = 0; index < count; index++)
    chunks.push((await storage.chunk(prefix, entry.path, index)) ?? new Blob());
  return { ...entry, chunkBytes, chunkSha256: await chunkHashes(new Blob(chunks), chunkBytes) };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** A complete package record. */
export function completeRecord(
  manifest: PackageManifest,
  kind: PackageRecord['kind'],
  bytes: number,
  manifestUrl: string | undefined,
): PackageRecord {
  return {
    manifest,
    kind,
    state: 'complete',
    installedAtMs: Date.now(),
    bytes,
    ...(manifestUrl === undefined ? {} : { manifestUrl }),
  };
}
