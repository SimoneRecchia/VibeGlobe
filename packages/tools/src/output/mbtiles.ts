/** MBTiles 1.3 writing and reading with `node:sqlite` (rows in a fixed order, so equal inputs give equal files). */
import { rmSync } from 'node:fs';
import type { DatabaseSync as Database } from 'node:sqlite';

/** Loads `node:sqlite` on first use, so importing the package prints no experimental warning. */
function sqlite(): typeof import('node:sqlite') {
  return process.getBuiltinModule('node:sqlite');
}

/** A tile to write. */
export interface MbtilesTile {
  z: number;
  x: number;
  y: number;
  read: () => Uint8Array;
}

/** Writes an MBTiles file with the given metadata (string values) and tiles (XYZ rows are flipped to TMS). */
export function writeMbtiles(path: string, tiles: MbtilesTile[], metadata: Record<string, string>): void {
  rmSync(path, { force: true });
  const db: Database = new (sqlite().DatabaseSync)(path);
  try {
    db.exec('PRAGMA journal_mode = OFF; PRAGMA page_size = 4096;');
    db.exec('CREATE TABLE metadata (name TEXT, value TEXT); CREATE UNIQUE INDEX name ON metadata (name);');
    db.exec(
      'CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);' +
        'CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);',
    );
    db.exec('BEGIN');
    const meta = db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)');
    for (const name of Object.keys(metadata).sort()) meta.run(name, metadata[name] ?? '');
    const insert = db.prepare('INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)');
    const sorted = [...tiles].sort((a, b) => a.z - b.z || a.x - b.x || a.y - b.y);
    for (const tile of sorted) insert.run(tile.z, tile.x, 2 ** tile.z - 1 - tile.y, tile.read());
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

/** Reads an MBTiles file: its metadata and a tile lookup by XYZ coordinates. */
export function readMbtiles(path: string): {
  metadata: Record<string, string>;
  tile: (z: number, x: number, y: number) => Uint8Array | undefined;
  count: () => number;
  close: () => void;
} {
  const db: Database = new (sqlite().DatabaseSync)(path, { readOnly: true });
  const rows = db.prepare('SELECT name, value FROM metadata').all() as { name: string; value: string }[];
  const select = db.prepare('SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?');
  return {
    metadata: Object.fromEntries(rows.map((row) => [row.name, row.value])),
    tile: (z, x, y) => {
      const row = select.get(z, x, 2 ** z - 1 - y) as { tile_data: Uint8Array } | undefined;
      return row ? new Uint8Array(row.tile_data) : undefined;
    },
    count: () => (db.prepare('SELECT COUNT(*) AS n FROM tiles').get() as { n: number }).n,
    close: () => db.close(),
  };
}
