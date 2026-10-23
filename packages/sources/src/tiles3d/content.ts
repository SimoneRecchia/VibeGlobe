/**
 * 3D Tiles tile content (F460; ADR 0041): the 1.0 binary formats (Batched 3D Model `b3dm`, Instanced 3D Model `i3dm`,
 * Point Cloud `pnts`, Composite `cmpt`) and 1.1 glTF content (`glb`, or glTF JSON). Headers, feature tables and batch
 * tables are parsed and bounds-checked; the embedded glTF is returned as bytes for the glTF loader (M10). Content
 * bytes are untrusted: every failure is a typed result (the tile is marked failed and its parent stays visible), and
 * parsing never throws.
 */

/** A feature or batch table: its JSON header and binary body. */
export interface BinaryTable {
  readonly json: Readonly<Record<string, unknown>>;
  readonly binary: Uint8Array;
}

/** Parsed content. */
export type ParsedContent =
  | {
      readonly type: 'b3dm';
      readonly featureTable: BinaryTable;
      readonly batchTable: BinaryTable;
      readonly batchLength: number;
      readonly glb: Uint8Array;
    }
  | {
      readonly type: 'i3dm';
      readonly featureTable: BinaryTable;
      readonly batchTable: BinaryTable;
      readonly instancesLength: number;
      /** Embedded glb, or the URI of an external glTF. */
      readonly glb?: Uint8Array;
      readonly gltfUri?: string;
    }
  | {
      readonly type: 'pnts';
      readonly featureTable: BinaryTable;
      readonly batchTable: BinaryTable;
      readonly pointsLength: number;
    }
  | { readonly type: 'cmpt'; readonly tiles: readonly ParsedContent[] }
  | { readonly type: 'glb'; readonly glb: Uint8Array }
  | { readonly type: 'gltf'; readonly json: Readonly<Record<string, unknown>> }
  | { readonly type: 'tileset'; readonly json: Readonly<Record<string, unknown>> };

/** A content that could not be parsed. */
export interface ContentError {
  readonly type: 'error';
  readonly message: string;
}

/** Bytes a content may have before it is refused (bounded work on untrusted input). */
export const MAX_CONTENT_BYTES = 512 * 1024 * 1024;
const MAX_COMPOSITE_DEPTH = 8;
const decoder = new TextDecoder();

class ContentFailure extends Error {}

function fail(message: string): never {
  throw new ContentFailure(message);
}

function magic(bytes: Uint8Array, offset = 0): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

function readJson(bytes: Uint8Array, what: string): Record<string, unknown> {
  if (bytes.length === 0) return {};
  // JSON headers are padded with spaces (and some writers pad with zeros).
  const text = decoder.decode(bytes).replace(/[\0\s]+$/, '');
  if (text === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    fail(`${what} is not valid JSON`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${what} must be a JSON object`);
  return value as Record<string, unknown>;
}

function slice(bytes: Uint8Array, offset: number, length: number, what: string): Uint8Array {
  if (!Number.isInteger(length) || length < 0 || offset + length > bytes.length) fail(`${what} runs past the content`);
  return bytes.subarray(offset, offset + length);
}

/** Reads `featureTable` and `batchTable` (four lengths after the header) and returns the offset after them. */
function readTables(bytes: Uint8Array, view: DataView, at: number, headerEnd: number) {
  const lengths = [0, 4, 8, 12].map((o) => view.getUint32(at + o, true));
  let offset = headerEnd;
  const parts = lengths.map((length, i) => {
    const part = slice(
      bytes,
      offset,
      length,
      ['feature table JSON', 'feature table binary', 'batch table JSON', 'batch table binary'][i] ?? '',
    );
    offset += length;
    return part;
  });
  return {
    featureTable: {
      json: readJson(parts[0] ?? new Uint8Array(), 'feature table'),
      binary: parts[1] ?? new Uint8Array(),
    },
    batchTable: { json: readJson(parts[2] ?? new Uint8Array(), 'batch table'), binary: parts[3] ?? new Uint8Array() },
    offset,
  };
}

function header(bytes: Uint8Array, view: DataView, size: number, kind: string): number {
  if (bytes.length < size) fail(`${kind} header truncated`);
  const version = view.getUint32(4, true);
  if (version !== 1) fail(`${kind} version ${version} is not supported`);
  const byteLength = view.getUint32(8, true);
  if (byteLength > bytes.length || byteLength < size)
    fail(`${kind} byteLength ${byteLength} does not match the content`);
  return byteLength;
}

function requireInteger(table: BinaryTable, name: string, kind: string): number {
  const value = table.json[name];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) fail(`${kind} feature table needs ${name}`);
  return value;
}

function parseB3dm(bytes: Uint8Array, view: DataView): ParsedContent {
  const end = header(bytes, view, 28, 'b3dm');
  const content = bytes.subarray(0, end);
  const tables = readTables(content, view, 12, 28);
  const batchLength = requireInteger(tables.featureTable, 'BATCH_LENGTH', 'b3dm');
  const glb = content.subarray(tables.offset);
  if (magic(glb) !== 'glTF') fail('b3dm does not embed a binary glTF');
  return { type: 'b3dm', featureTable: tables.featureTable, batchTable: tables.batchTable, batchLength, glb };
}

function parseI3dm(bytes: Uint8Array, view: DataView): ParsedContent {
  const end = header(bytes, view, 32, 'i3dm');
  const content = bytes.subarray(0, end);
  const tables = readTables(content, view, 12, 32);
  const gltfFormat = view.getUint32(28, true);
  const instancesLength = requireInteger(tables.featureTable, 'INSTANCES_LENGTH', 'i3dm');
  if (
    tables.featureTable.json['POSITION'] === undefined &&
    tables.featureTable.json['POSITION_QUANTIZED'] === undefined
  ) {
    fail('i3dm feature table needs POSITION or POSITION_QUANTIZED');
  }
  checkProperty(tables.featureTable, 'POSITION', instancesLength * 12);
  const body = content.subarray(tables.offset);
  const base = {
    type: 'i3dm' as const,
    featureTable: tables.featureTable,
    batchTable: tables.batchTable,
    instancesLength,
  };
  if (gltfFormat === 1) {
    if (magic(body) !== 'glTF') fail('i3dm does not embed a binary glTF');
    return { ...base, glb: body };
  }
  if (gltfFormat === 0) return { ...base, gltfUri: decoder.decode(body).replace(/[\0\s]+$/, '') };
  return fail(`i3dm gltfFormat ${gltfFormat} is not supported`);
}

/** Checks that a binary feature-table property fits in the binary body. */
function checkProperty(table: BinaryTable, name: string, byteLength: number): void {
  const ref = table.json[name];
  if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) return;
  const offset = (ref as { byteOffset?: unknown }).byteOffset;
  if (typeof offset !== 'number' || offset < 0 || offset + byteLength > table.binary.length) {
    fail(`feature table property ${name} runs past the binary body`);
  }
}

function parsePnts(bytes: Uint8Array, view: DataView): ParsedContent {
  const end = header(bytes, view, 28, 'pnts');
  const tables = readTables(bytes.subarray(0, end), view, 12, 28);
  const pointsLength = requireInteger(tables.featureTable, 'POINTS_LENGTH', 'pnts');
  const json = tables.featureTable.json;
  if (json['POSITION'] === undefined && json['POSITION_QUANTIZED'] === undefined) {
    fail('pnts feature table needs POSITION or POSITION_QUANTIZED');
  }
  checkProperty(tables.featureTable, 'POSITION', pointsLength * 12);
  checkProperty(tables.featureTable, 'POSITION_QUANTIZED', pointsLength * 6);
  checkProperty(tables.featureTable, 'RGB', pointsLength * 3);
  checkProperty(tables.featureTable, 'RGBA', pointsLength * 4);
  checkProperty(tables.featureTable, 'NORMAL', pointsLength * 12);
  return { type: 'pnts', featureTable: tables.featureTable, batchTable: tables.batchTable, pointsLength };
}

function parseCmpt(bytes: Uint8Array, view: DataView, depth: number): ParsedContent {
  const end = header(bytes, view, 16, 'cmpt');
  if (depth > MAX_COMPOSITE_DEPTH) fail('composite tiles nested too deeply');
  const count = view.getUint32(12, true);
  const tiles: ParsedContent[] = [];
  let offset = 16;
  for (let i = 0; i < count; i++) {
    if (offset + 12 > end) fail(`cmpt inner tile ${i} runs past the content`);
    const innerLength = new DataView(bytes.buffer, bytes.byteOffset + offset, 12).getUint32(8, true);
    if (innerLength < 12 || offset + innerLength > end) fail(`cmpt inner tile ${i} has a bad byteLength`);
    tiles.push(parse(bytes.subarray(offset, offset + innerLength), depth + 1));
    offset += innerLength;
  }
  return { type: 'cmpt', tiles };
}

function parseGlb(bytes: Uint8Array, view: DataView): ParsedContent {
  if (bytes.length < 12) fail('glb header truncated');
  if (view.getUint32(4, true) !== 2) fail('only glTF 2.0 binaries are supported');
  const length = view.getUint32(8, true);
  if (length > bytes.length || length < 12) fail('glb length does not match the content');
  return { type: 'glb', glb: bytes.subarray(0, length) };
}

function parse(bytes: Uint8Array, depth: number): ParsedContent {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kind = bytes.length >= 4 ? magic(bytes) : '';
  if (kind === 'b3dm') return parseB3dm(bytes, view);
  if (kind === 'i3dm') return parseI3dm(bytes, view);
  if (kind === 'pnts') return parsePnts(bytes, view);
  if (kind === 'cmpt') return parseCmpt(bytes, view, depth);
  if (kind === 'glTF') return parseGlb(bytes, view);
  const json = readJson(bytes, 'content');
  if (json['asset'] !== undefined && json['root'] !== undefined) return { type: 'tileset', json };
  if (json['asset'] !== undefined) return { type: 'gltf', json };
  return fail(`unknown content format "${kind.replace(/[^\x20-\x7e]/g, '?')}"`);
}

/** Parses tile content by its magic (or as JSON: external tileset or glTF). Never throws. */
export function parseTileContent(input: ArrayBuffer | Uint8Array): ParsedContent | ContentError {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length > MAX_CONTENT_BYTES) return { type: 'error', message: 'content too large' };
  try {
    return parse(bytes, 0);
  } catch (error) {
    if (error instanceof ContentFailure) return { type: 'error', message: error.message };
    return { type: 'error', message: `content could not be parsed: ${String(error)}` };
  }
}

const COMPONENT_SIZES: Readonly<Record<string, number>> = {
  BYTE: 1,
  UNSIGNED_BYTE: 1,
  SHORT: 2,
  UNSIGNED_SHORT: 2,
  INT: 4,
  UNSIGNED_INT: 4,
  FLOAT: 4,
  DOUBLE: 8,
};
const TYPE_COUNTS: Readonly<Record<string, number>> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function readComponent(view: DataView, offset: number, type: string): number {
  switch (type) {
    case 'BYTE':
      return view.getInt8(offset);
    case 'UNSIGNED_BYTE':
      return view.getUint8(offset);
    case 'SHORT':
      return view.getInt16(offset, true);
    case 'UNSIGNED_SHORT':
      return view.getUint16(offset, true);
    case 'INT':
      return view.getInt32(offset, true);
    case 'UNSIGNED_INT':
      return view.getUint32(offset, true);
    case 'FLOAT':
      return view.getFloat32(offset, true);
    default:
      return view.getFloat64(offset, true);
  }
}

/**
 * The properties of one feature (batch id) from a batch table: JSON arrays and binary properties
 * (`{ byteOffset, componentType, type }`). Out-of-range ids and malformed properties yield no value. Used by picking
 * (F466).
 */
export function batchProperties(table: BinaryTable, batchId: number, batchLength: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!Number.isInteger(batchId) || batchId < 0 || batchId >= batchLength) return out;
  const view = new DataView(table.binary.buffer, table.binary.byteOffset, table.binary.byteLength);
  for (const [name, value] of Object.entries(table.json)) {
    if (name === 'extensions' || name === 'extras') continue;
    if (Array.isArray(value)) {
      if (batchId < value.length) out[name] = value[batchId];
      continue;
    }
    if (value === null || typeof value !== 'object') continue;
    const { byteOffset, componentType, type } = value as {
      byteOffset?: unknown;
      componentType?: unknown;
      type?: unknown;
    };
    const size = COMPONENT_SIZES[String(componentType)];
    const count = TYPE_COUNTS[String(type)];
    if (typeof byteOffset !== 'number' || size === undefined || count === undefined) continue;
    const start = byteOffset + batchId * size * count;
    if (start < 0 || start + size * count > table.binary.length) continue;
    const values = Array.from({ length: count }, (_, i) =>
      readComponent(view, start + i * size, String(componentType)),
    );
    out[name] = count === 1 ? values[0] : values;
  }
  return out;
}
