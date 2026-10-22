// Typed stub of the PMTiles and MBTiles adapters of the fourth session (F232, F233; docs/parallel-tracks.md), for this
// package's tests until those adapters are on `main`: the same signatures and transport behavior (a missing tile is a
// 404, a read error is a network error), built directly on the `pmtiles` and `sql.js` libraries.
import {
  WEB_MERCATOR_TILING,
  type AbortHandle,
  type ImagerySource,
  type TileCoord,
  type TileRequest,
  type TileTransport,
  type TransportResult,
} from '@vibeglobe/core';
import { PMTiles, type RangeResponse, type Source } from 'pmtiles';
import type { ArchiveAdapters } from '../packages/reader.js';

type Reader = (z: number, x: number, y: number) => Promise<ArrayBuffer | undefined>;

function transportOf(read: Reader): TileTransport {
  return {
    start(request: TileRequest, _timeouts, done: (result: TransportResult) => void): AbortHandle {
      let settled = false;
      const finish = (result: TransportResult): void => {
        if (!settled) done(result);
        settled = true;
      };
      const [z, x, y] = (request.url.split('#')[1] ?? '').split('/').map(Number);
      read(z ?? 0, x ?? 0, y ?? 0)
        .then((bytes) =>
          finish(
            bytes
              ? { kind: 'ok', bytes, contentType: 'image/png' }
              : { kind: 'status', status: 404, retryAfterMs: undefined },
          ),
        )
        .catch(() => finish({ kind: 'network-error' }));
      return () => finish({ kind: 'aborted' });
    },
  };
}

function sourceOf(id: string, base: string, minLevel: number, maxLevel: number, read: Reader): ImagerySource {
  return {
    id,
    tiling: WEB_MERCATOR_TILING,
    minLevel,
    maxLevel,
    tileSizePx: 256,
    pixelRatio: 1,
    decoder: 'image',
    transport: transportOf(read),
    request(coord: TileCoord, out: TileRequest): TileRequest | 'noData' {
      if (coord.level < minLevel || coord.level > maxLevel) return 'noData';
      out.url = `${base}#${coord.level}/${coord.x}/${coord.y}`;
      out.hostIndex = 0;
      return out;
    },
  };
}

/**
 * The stub adapters; in browsers `wasmUrl` locates sql.js's WebAssembly file.
 *
 * @public (imported by URL from e2e/support/offline-page.ts)
 */
export function createStubAdapters(options: { wasmUrl?: string } = {}): ArchiveAdapters {
  return {
    async pmtiles({ id, archive, fetch: fetchImpl }) {
      const bytes: Source = {
        getKey: () => archive,
        getBytes: async (offset, length): Promise<RangeResponse> => {
          const response = await fetchImpl(archive, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
          return { data: await response.arrayBuffer() };
        },
      };
      const pmtiles = new PMTiles(bytes);
      const header = await pmtiles.getHeader();
      return sourceOf(
        id,
        archive,
        header.minZoom,
        header.maxZoom,
        async (z, x, y) => (await pmtiles.getZxy(z, x, y))?.data,
      );
    },
    async mbtiles({ id, package: url, fetch: fetchImpl }) {
      const { default: initSqlJs } = await import('sql.js');
      const sql = await initSqlJs(options.wasmUrl === undefined ? {} : { locateFile: () => options.wasmUrl ?? '' });
      const db = new sql.Database(new Uint8Array(await (await fetchImpl(url)).arrayBuffer()));
      const range = db.exec('SELECT MIN(zoom_level), MAX(zoom_level) FROM tiles')[0]?.values[0] ?? [0, 0];
      const statement = db.prepare(
        'SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?',
      );
      return sourceOf(id, url, Number(range[0]), Number(range[1]), (z, x, y) => {
        statement.bind([z, x, 2 ** z - 1 - y]);
        const found = statement.step() ? statement.get()[0] : undefined;
        statement.reset();
        return Promise.resolve(found instanceof Uint8Array ? found.slice().buffer : undefined);
      });
    },
  };
}

/** The stub adapters for Node tests. */
export const stubAdapters = createStubAdapters();
