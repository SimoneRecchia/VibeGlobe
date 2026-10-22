/**
 * Geoid grid files for geoid-referenced terrain (ADR 0027, F133; `docs/guides/terrain.md`).
 *
 *   node scripts/geoid-grid.ts convert <grid.txt> <out.bin>
 *     Writes a VGEOID1 file from a text grid: one `latitudeDeg longitudeDeg undulationMeters` line per node of a
 *     regular grid covering 90° N to 90° S and 180° W eastward (a node at 180° E repeats 180° W and is dropped).
 *
 *   node scripts/geoid-grid.ts check <grid.bin> <reference.txt> [toleranceMeters]
 *     Compares the engine's interpolated undulation at published reference points (`latitudeDeg longitudeDeg
 *     undulationMeters` per line) and exits 1 if any differs by more than the tolerance (default 1 m).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { geoidModel, readGeoidFile, undulationMeters, writeGeoidFile, type GeoidModel } from '@vibeglobe/core';

/** `latitudeDeg longitudeDeg value` triples of a text file; blank lines and `#` comments are skipped. */
export function readTriples(text: string): [number, number, number][] {
  const triples: [number, number, number][] = [];
  for (const line of text.split('\n')) {
    const fields = line
      .replace(/#.*/, '')
      .trim()
      .split(/[\s,;]+/);
    if (fields.length < 3 || fields[0] === '') continue;
    const [lat, lon, value] = fields.map(Number);
    if (lat === undefined || lon === undefined || value === undefined || ![lat, lon, value].every(Number.isFinite))
      throw new RangeError(`not a "latitude longitude value" line: ${line}`);
    triples.push([lat, lon, value]);
  }
  return triples;
}

/** A geoid model from the nodes of a regular latitude–longitude grid, in any order. */
export function gridFromTriples(triples: readonly [number, number, number][]): GeoidModel {
  const key = (value: number): number => Math.round(value * 1e6);
  const lats = [...new Set(triples.map(([lat]) => key(lat)))].sort((a, b) => b - a);
  const lons = [...new Set(triples.map(([, lon]) => key(lon < 180 ? lon : lon - 360)))].sort((a, b) => a - b);
  if (lats[0] !== key(90) || lats.at(-1) !== key(-90)) throw new RangeError('the grid must span 90° N to 90° S');
  if (lons[0] !== key(-180)) throw new RangeError('the grid columns must start at 180° W');
  const values = new Float32Array(lats.length * lons.length).fill(Number.NaN);
  const row = new Map(lats.map((lat, i) => [lat, i]));
  const column = new Map(lons.map((lon, i) => [lon, i]));
  for (const [lat, lon, value] of triples) {
    const r = row.get(key(lat));
    const c = column.get(key(lon < 180 ? lon : lon - 360));
    if (r !== undefined && c !== undefined) values[r * lons.length + c] = value;
  }
  // geoidModel rejects a grid with holes (a NaN left where no line gave a node).
  return geoidModel(lats.length, lons.length, values);
}

/** The reference points whose interpolated undulation differs from the published one by more than `tolerance`. */
export function checkReferences(
  model: GeoidModel,
  references: readonly [number, number, number][],
  toleranceMeters: number,
): { maxErrorMeters: number; failures: [number, number, number, number][] } {
  const rad = Math.PI / 180;
  let maxErrorMeters = 0;
  const failures: [number, number, number, number][] = [];
  for (const [lat, lon, published] of references) {
    const value = undulationMeters(model, lon * rad, lat * rad);
    const error = Math.abs(value - published);
    maxErrorMeters = Math.max(maxErrorMeters, error);
    if (error > toleranceMeters) failures.push([lat, lon, published, value]);
  }
  return { maxErrorMeters, failures };
}

function main(args: readonly string[]): number {
  const [command, input, other, tolerance] = args;
  if (command === 'convert' && input && other) {
    const model = gridFromTriples(readTriples(readFileSync(input, 'utf8')));
    writeFileSync(other, new Uint8Array(writeGeoidFile(model)));
    console.log(`${other}: ${model.rows} × ${model.columns} undulations`);
    return 0;
  }
  if (command === 'check' && input && other) {
    const bytes = readFileSync(input);
    const model = readGeoidFile(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const result = checkReferences(model, readTriples(readFileSync(other, 'utf8')), Number(tolerance ?? 1));
    console.log(`maximum error ${result.maxErrorMeters.toFixed(3)} m`);
    for (const [lat, lon, published, value] of result.failures)
      console.log(`  ${lat} ${lon}: published ${published} m, interpolated ${value.toFixed(3)} m`);
    return result.failures.length === 0 ? 0 : 1;
  }
  console.error('usage: geoid-grid.ts convert <grid.txt> <out.bin> | check <grid.bin> <reference.txt> [toleranceM]');
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2));
