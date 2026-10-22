import { DEFAULT_CHUNK_BYTES, type PackageFileEntry } from './manifest.js';
import { sha256Hex } from './integrity.js';

/** Bytes of a package file failed their checksum. */
export class IntegrityError extends Error {
  constructor(
    message: string,
    readonly chunk: number,
  ) {
    super(message);
    this.name = 'IntegrityError';
  }
}

/** Reads raw, unverified chunks of a package file: from browser storage, or from a LAN server. */
export type ChunkLoader = (index: number, signal: AbortSignal | undefined) => Promise<ArrayBuffer>;

/** Chunks verified recently, kept so neighbouring reads do not hash again. */
const KEPT_CHUNKS = 8;

function parseRange(header: string | null, size: number): [number, number] {
  const match = /^bytes=(\d+)-(\d*)$/.exec(header ?? '');
  if (!match) return [0, size];
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) + 1 : size;
  return [start, Math.min(end, size)];
}

/**
 * A `fetch` that serves one package file to the PMTiles and MBTiles adapters: range requests are answered from chunks
 * that are checked against the manifest's per-chunk SHA-256 before use (F309). A chunk that fails is reported and its
 * read fails, so the adapter treats the tiles in it as missing and the engine keeps their ancestors.
 */
export function verifyingFetch(
  entry: PackageFileEntry,
  load: ChunkLoader,
  onCorrupt: (error: IntegrityError) => void,
): typeof fetch {
  const chunkBytes = entry.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  const kept = new Map<number, ArrayBuffer>();
  const corrupt = new Set<number>();
  const chunk = async (index: number, signal: AbortSignal | undefined): Promise<ArrayBuffer> => {
    const cached = kept.get(index);
    if (cached) return cached;
    if (corrupt.has(index)) throw new IntegrityError(`chunk ${index} of ${entry.path} is corrupted`, index);
    const bytes = await load(index, signal);
    const expected = entry.chunkSha256?.[index];
    if (expected !== undefined && (await sha256Hex(bytes)) !== expected) {
      corrupt.add(index);
      const error = new IntegrityError(
        `${entry.path}: bytes ${index * chunkBytes}–${index * chunkBytes + bytes.byteLength - 1} fail their SHA-256 check`,
        index,
      );
      onCorrupt(error);
      throw error;
    }
    kept.set(index, bytes);
    if (kept.size > KEPT_CHUNKS) kept.delete(kept.keys().next().value ?? index);
    return bytes;
  };
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const range = new Headers(init?.headers).get('Range');
    const [start, end] = parseRange(range, entry.bytes);
    const out = new Uint8Array(Math.max(0, end - start));
    let length = out.length;
    const first = Math.floor(start / chunkBytes);
    for (let index = first; index * chunkBytes < end; index++) {
      const chunkStart = index * chunkBytes;
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await chunk(index, init?.signal ?? undefined));
      } catch (error) {
        // A read that starts in good data ends before the bad chunk (a short read, as at the end of a file), so the
        // header and directories stay usable when only tile data is hit.
        if (!(error instanceof IntegrityError) || index === first) throw error;
        length = chunkStart - start;
        break;
      }
      const from = Math.max(start, chunkStart) - chunkStart;
      const to = Math.min(end, chunkStart + bytes.length) - chunkStart;
      out.set(bytes.subarray(from, to), chunkStart + from - start);
    }
    const body = out.subarray(0, length);
    return new Response(body, {
      status: range === null ? 200 : 206,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) },
    });
  }) as typeof fetch;
}

/** Loads chunks of a file from a LAN or static HTTP server with range requests (offline mode 1, F295). */
export function httpChunkLoader(fetchImpl: typeof fetch, url: string, entry: PackageFileEntry): ChunkLoader {
  const chunkBytes = entry.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  return async (index, signal) => {
    const start = index * chunkBytes;
    const end = Math.min(entry.bytes, start + chunkBytes) - 1;
    const response = await fetchImpl(url, {
      headers: { Range: `bytes=${start}-${end}` },
      mode: 'cors',
      credentials: 'omit',
      ...(signal ? { signal } : {}),
    });
    if (response.status !== 206 && response.status !== 200) throw new Error(`HTTP ${response.status} for ${url}`);
    const bytes = await response.arrayBuffer();
    // A server that ignores ranges answers with the whole file.
    return response.status === 200 ? bytes.slice(start, end + 1) : bytes;
  };
}
