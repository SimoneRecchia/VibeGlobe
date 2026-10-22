// Writes small MBTiles packages in memory with sql.js for the MBTiles conformance suite: the plain `tiles` table or
// the deduplicated `map` and `images` schema, rows in TMS order as the specification requires.
import initSqlJs from 'sql.js';

/** A package holding `tiles` keyed by XYZ `z/x/y`, with the given metadata rows. */
export async function writeMbtiles(
  tiles: ReadonlyMap<string, Uint8Array>,
  metadata: Readonly<Record<string, string>>,
  schema: 'plain' | 'deduplicated' = 'plain',
): Promise<Uint8Array<ArrayBuffer>> {
  const sql = await initSqlJs();
  const db = new sql.Database();
  db.run('CREATE TABLE metadata (name TEXT, value TEXT)');
  for (const [name, value] of Object.entries(metadata)) db.run('INSERT INTO metadata VALUES (?, ?)', [name, value]);
  if (schema === 'plain') {
    db.run('CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)');
  } else {
    db.run('CREATE TABLE map (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_id TEXT)');
    db.run('CREATE TABLE images (tile_data BLOB, tile_id TEXT)');
  }
  const ids = new Map<string, string>();
  for (const [key, bytes] of tiles) {
    const [z = 0, x = 0, y = 0] = key.split('/').map(Number);
    const row = 2 ** z - 1 - y;
    if (schema === 'plain') {
      db.run('INSERT INTO tiles VALUES (?, ?, ?, ?)', [z, x, row, bytes]);
      continue;
    }
    const content = Array.from(bytes).join(',');
    let id = ids.get(content);
    if (id === undefined) {
      id = `t${ids.size}`;
      ids.set(content, id);
      db.run('INSERT INTO images VALUES (?, ?)', [bytes, id]);
    }
    db.run('INSERT INTO map VALUES (?, ?, ?, ?)', [z, x, row, id]);
  }
  const out = db.export();
  db.close();
  return new Uint8Array(out);
}
