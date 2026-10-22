import type { PackageArea } from './area.js';
import { chunkHashes, sha256Hex } from './integrity.js';
import { DEFAULT_CHUNK_BYTES, type PackageManifest, type PackageSourceEntry } from './manifest.js';

/** Input of {@link createManifest}. */
export interface ManifestInput {
  readonly id: string;
  readonly version: string;
  readonly name?: string;
  readonly area: PackageArea;
  readonly sources: readonly PackageSourceEntry[];
  readonly files: readonly { readonly path: string; readonly format: 'pmtiles' | 'mbtiles'; readonly data: Blob }[];
  /** Chunk size of the per-chunk checksums (default 1 MiB). */
  readonly chunkBytes?: number;
}

/**
 * Writes the manifest of a package from its files: sizes, SHA-256 of each file and of each chunk (ADR 0029). Runs in
 * browsers and in Node; the files are hashed in memory, one file at a time.
 */
export async function createManifest(input: ManifestInput): Promise<PackageManifest> {
  const chunkBytes = input.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const files = [];
  for (const file of input.files) {
    files.push({
      path: file.path,
      format: file.format,
      bytes: file.data.size,
      sha256: await sha256Hex(await file.data.arrayBuffer()),
      chunkBytes,
      chunkSha256: await chunkHashes(file.data, chunkBytes),
    });
  }
  return {
    id: input.id,
    version: input.version,
    ...(input.name === undefined ? {} : { name: input.name }),
    area: input.area,
    sources: input.sources,
    files,
  };
}
