// A minimal MBTiles writer for fixture packages (sql.js): a metadata table and a tiles table with TMS rows.

/**
 * Writes an MBTiles database of the tiles with the metadata rows; `wasmUrl` locates sql.js's WebAssembly file in
 * browsers.
 *
 * @public (imported by URL from e2e/support/offline-fixtures.ts)
 */
export async function writeMbtiles(
  tiles: readonly { z: number; x: number; y: number; bytes: Uint8Array }[],
  metadata: Readonly<Record<string, string>>,
  wasmUrl?: string,
): Promise<Uint8Array> {
  const { default: initSqlJs } = await import('sql.js');
  const sql = await initSqlJs(wasmUrl === undefined ? {} : { locateFile: () => wasmUrl });
  const db = new sql.Database();
  db.run('CREATE TABLE metadata (name text, value text)');
  db.run('CREATE TABLE tiles (zoom_level integer, tile_column integer, tile_row integer, tile_data blob)');
  for (const [name, value] of Object.entries(metadata)) db.run('INSERT INTO metadata VALUES (?, ?)', [name, value]);
  for (const t of tiles) db.run('INSERT INTO tiles VALUES (?, ?, ?, ?)', [t.z, t.x, 2 ** t.z - 1 - t.y, t.bytes]);
  const bytes = db.export();
  db.close();
  return bytes;
}
