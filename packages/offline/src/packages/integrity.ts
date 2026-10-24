// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Integrity checks of package files (F309): SHA-256 of the whole file and of each chunk, and the PMTiles v3 header's
 * layout, so a corruption is reported with the part of the file it hit (header, directories, metadata, tile data).
 */

/** Lowercase hex SHA-256 of bytes (Web Crypto, in browsers, workers and Node). */
export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', view as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The byte ranges of a PMTiles v3 archive's parts, read from its header. */
export interface PmtilesLayout {
  readonly rootDirectory: readonly [number, number];
  readonly metadata: readonly [number, number];
  readonly leafDirectories: readonly [number, number];
  readonly tileData: readonly [number, number];
}

/** Size of the PMTiles v3 header. */
export const PMTILES_HEADER_BYTES = 127;

/** Reads the layout from a PMTiles v3 header, or describes why the header is invalid. */
export function pmtilesLayout(header: Uint8Array, fileBytes: number): PmtilesLayout | string {
  if (header.length < PMTILES_HEADER_BYTES) return 'the header is truncated';
  const magic = String.fromCharCode(...header.subarray(0, 7));
  if (magic !== 'PMTiles') return 'the header does not start with the PMTiles magic number';
  if (header[7] !== 3) return `the header announces version ${header[7] ?? '?'}, not 3`;
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const u64 = (offset: number): number => Number(view.getBigUint64(offset, true));
  const part = (offset: number): [number, number] => [u64(offset), u64(offset + 8)];
  const layout: PmtilesLayout = {
    rootDirectory: part(8),
    metadata: part(24),
    leafDirectories: part(40),
    tileData: part(56),
  };
  for (const [name, [start, length]] of Object.entries(layout) as [string, [number, number]][]) {
    if (start + length > fileBytes) return `the header places the ${name} beyond the end of the file`;
  }
  return layout;
}

const PART_NAMES: Record<keyof PmtilesLayout, string> = {
  rootDirectory: 'root directory',
  metadata: 'metadata',
  leafDirectories: 'leaf directories',
  tileData: 'tile data',
};

/** The parts of a PMTiles archive that a byte range touches, for error messages. */
export function partsOfRange(layout: PmtilesLayout | undefined, start: number, end: number): string[] {
  const parts: string[] = [];
  if (start < PMTILES_HEADER_BYTES) parts.push('header');
  if (!layout) return parts.length > 0 ? parts : ['data'];
  for (const [name, [offset, length]] of Object.entries(layout) as [keyof PmtilesLayout, [number, number]][]) {
    if (length > 0 && start < offset + length && end > offset) parts.push(PART_NAMES[name]);
  }
  return parts;
}

/** SHA-256 of each chunk of a file. */
export async function chunkHashes(file: Blob, chunkBytes: number): Promise<string[]> {
  const hashes: string[] = [];
  for (let offset = 0; offset < file.size; offset += chunkBytes)
    hashes.push(await sha256Hex(await file.slice(offset, offset + chunkBytes).arrayBuffer()));
  return hashes;
}
