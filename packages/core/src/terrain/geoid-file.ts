/**
 * The geoid grid file a consumer hosts for geoid-referenced terrain (ADR 0027, F133): the ASCII magic `VGEOID1\0`,
 * the row and column counts as little-endian uint32, then rows × columns little-endian float32 undulations in meters,
 * rows from 90° N to 90° S inclusive, columns eastward from 180° W. `docs/guides/terrain.md` shows how to write one
 * from a published geoid model.
 */
import { geoidModel, type GeoidModel } from './vertical-datum.js';

const MAGIC = 'VGEOID1\0';
const HEADER_BYTES = 16;

/** Reads a geoid grid file; throws a `RangeError` naming the problem for anything else. */
export function readGeoidFile(bytes: ArrayBuffer): GeoidModel {
  if (bytes.byteLength < HEADER_BYTES) throw new RangeError('geoid file: too short');
  const view = new DataView(bytes);
  let magic = '';
  for (let i = 0; i < MAGIC.length; i++) magic += String.fromCharCode(view.getUint8(i));
  if (magic !== MAGIC) throw new RangeError('geoid file: not a VGEOID1 file');
  const rows = view.getUint32(8, true);
  const columns = view.getUint32(12, true);
  if (bytes.byteLength !== HEADER_BYTES + rows * columns * 4)
    throw new RangeError(`geoid file: ${rows} × ${columns} values need ${HEADER_BYTES + rows * columns * 4} bytes`);
  const values = new Float32Array(rows * columns);
  for (let i = 0; i < values.length; i++) values[i] = view.getFloat32(HEADER_BYTES + i * 4, true);
  return geoidModel(rows, columns, values);
}

/** Writes a geoid grid file (tests, and the conversion script of the guide). */
export function writeGeoidFile(model: GeoidModel): ArrayBuffer {
  const bytes = new ArrayBuffer(HEADER_BYTES + model.undulationsMeters.length * 4);
  const view = new DataView(bytes);
  for (let i = 0; i < MAGIC.length; i++) view.setUint8(i, MAGIC.charCodeAt(i));
  view.setUint32(8, model.rows, true);
  view.setUint32(12, model.columns, true);
  model.undulationsMeters.forEach((value, i) => view.setFloat32(HEADER_BYTES + i * 4, value, true));
  return bytes;
}
