// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { PackageArea } from './area.js';

/** A credit a package's source requires. */
export interface PackageAttribution {
  readonly text: string;
  readonly url?: string;
}

/** One source of a package (docs/plan/api.md, `OfflinePackageManifest`). */
export interface PackageSourceEntry {
  /** The engine source whose tiles the package holds. */
  readonly sourceId: string;
  /** The file holding them. */
  readonly file: string;
  readonly minLevel: number;
  readonly maxLevel: number;
  readonly license: string;
  readonly attribution: PackageAttribution;
}

/** One file of a package with its checksums. */
export interface PackageFileEntry {
  /** Path relative to the manifest's URL. */
  readonly path: string;
  readonly format: 'pmtiles' | 'mbtiles';
  readonly bytes: number;
  /** SHA-256 of the whole file, lowercase hex. */
  readonly sha256: string;
  /** Chunk size of `chunkSha256`, in bytes. */
  readonly chunkBytes?: number;
  /** SHA-256 of each chunk, so reads verify only what they touch (F309). */
  readonly chunkSha256?: readonly string[];
}

/** The manifest of an offline package: what it holds, under which licenses, with checksums (ADR 0033). */
export interface PackageManifest {
  readonly id: string;
  readonly version: string;
  readonly name?: string;
  readonly area: PackageArea;
  readonly sources: readonly PackageSourceEntry[];
  readonly files: readonly PackageFileEntry[];
}

/** Default chunk size of package files: 1 MiB. */
export const DEFAULT_CHUNK_BYTES = 1024 * 1024;

/** A package the engine refused: `code` is stable, `message` names the package, file or source and the reason. */
export class PackageError extends Error {
  readonly code: PackageErrorCode;

  constructor(code: PackageErrorCode, message: string) {
    super(message);
    this.name = 'PackageError';
    this.code = code;
  }
}

/** Why a package was refused. */
export type PackageErrorCode =
  | 'invalid-manifest'
  | 'download-failed'
  | 'integrity'
  | 'unreadable'
  | 'not-installed'
  | 'packaging-forbidden'
  | 'packaging-disabled'
  | 'storage-unavailable';

const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Checks a parsed manifest's shape, or throws a {@link PackageError} naming the first problem. */
export function validateManifest(value: unknown): PackageManifest {
  const fail = (what: string): never => {
    throw new PackageError('invalid-manifest', `offline package manifest: ${what}`);
  };
  const m = value as Partial<PackageManifest> | null;
  if (!m || typeof m !== 'object') return fail('not a JSON object');
  if (!isString(m.id) || !/^[\w.-]+$/.test(m.id)) fail('id must be letters, digits, dots, dashes or underscores');
  if (!isString(m.version)) fail(`package '${String(m.id)}' has no version`);
  if (!m.area || typeof m.area !== 'object') fail(`package '${String(m.id)}' has no area`);
  if (!Array.isArray(m.files) || m.files.length === 0) fail(`package '${String(m.id)}' lists no files`);
  if (!Array.isArray(m.sources) || m.sources.length === 0) fail(`package '${String(m.id)}' lists no sources`);
  for (const file of m.files ?? []) {
    if (!isString(file.path) || file.path.includes('..')) fail(`a file path of '${String(m.id)}' is invalid`);
    if (file.format !== 'pmtiles' && file.format !== 'mbtiles') fail(`file '${file.path}' has an unknown format`);
    if (!Number.isInteger(file.bytes) || file.bytes <= 0) fail(`file '${file.path}' has no size`);
    if (!/^[0-9a-f]{64}$/.test(file.sha256)) fail(`file '${file.path}' has no SHA-256`);
  }
  for (const source of m.sources ?? []) {
    if (!isString(source.sourceId) || !m.files?.some((f) => f.path === source.file))
      fail(`a source of '${String(m.id)}' names no listed file`);
    if (!isString(source.license) || !isString(source.attribution?.text))
      fail(`source '${source.sourceId}' has no license or attribution`);
  }
  return m as PackageManifest;
}
