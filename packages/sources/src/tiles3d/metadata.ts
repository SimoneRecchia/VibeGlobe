/**
 * 3D Tiles 1.1 metadata (F460, F466; ADR 0041): schema classes and enums, metadata entities in JSON (tileset, group,
 * tile, content) resolved with defaults, `noData`, normalization, offset and scale, and binary property tables of
 * implicit subtrees (numbers, vectors, matrices, booleans, strings and enums; fixed- and variable-length arrays).
 * Values are bounds-checked; a malformed property yields no value instead of an exception.
 */

/** A class property of the schema. */
export interface SchemaProperty {
  readonly type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT2' | 'MAT3' | 'MAT4' | 'STRING' | 'BOOLEAN' | 'ENUM';
  readonly componentType?: string;
  readonly enumType?: string;
  readonly array?: boolean;
  readonly count?: number;
  readonly normalized?: boolean;
  readonly offset?: unknown;
  readonly scale?: unknown;
  readonly noData?: unknown;
  readonly default?: unknown;
}

/** A metadata schema (classes and enums), as the tileset declares it. */
export interface MetadataSchema {
  readonly classes?: Readonly<Record<string, { readonly properties?: Readonly<Record<string, SchemaProperty>> }>>;
  readonly enums?: Readonly<
    Record<
      string,
      { readonly valueType?: string; readonly values: readonly { readonly name: string; readonly value: number }[] }
    >
  >;
}

const COMPONENTS: Readonly<Record<string, { size: number; max: number; signed: boolean }>> = {
  INT8: { size: 1, max: 127, signed: true },
  UINT8: { size: 1, max: 255, signed: false },
  INT16: { size: 2, max: 32767, signed: true },
  UINT16: { size: 2, max: 65535, signed: false },
  INT32: { size: 4, max: 2147483647, signed: true },
  UINT32: { size: 4, max: 4294967295, signed: false },
  INT64: { size: 8, max: 2 ** 63 - 1, signed: true },
  UINT64: { size: 8, max: 2 ** 64 - 1, signed: false },
  FLOAT32: { size: 4, max: 1, signed: true },
  FLOAT64: { size: 8, max: 1, signed: true },
};
const COUNTS: Readonly<Record<string, number>> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
  ENUM: 1,
};

function readComponent(view: DataView, offset: number, type: string): number {
  switch (type) {
    case 'INT8':
      return view.getInt8(offset);
    case 'UINT8':
      return view.getUint8(offset);
    case 'INT16':
      return view.getInt16(offset, true);
    case 'UINT16':
      return view.getUint16(offset, true);
    case 'INT32':
      return view.getInt32(offset, true);
    case 'UINT32':
      return view.getUint32(offset, true);
    case 'INT64':
      return Number(view.getBigInt64(offset, true));
    case 'UINT64':
      return Number(view.getBigUint64(offset, true));
    case 'FLOAT32':
      return view.getFloat32(offset, true);
    default:
      return view.getFloat64(offset, true);
  }
}

function transform(value: number, i: number, property: SchemaProperty): number {
  const component = COMPONENTS[property.componentType ?? ''];
  let v = value;
  if (property.normalized === true && component !== undefined) {
    v = component.signed ? Math.max(v / component.max, -1) : v / component.max;
  }
  const pick = (x: unknown, fallback: number) =>
    Array.isArray(x) ? Number(x[i] ?? fallback) : typeof x === 'number' ? x : fallback;
  return v * pick(property.scale, 1) + pick(property.offset, 0);
}

function enumName(schema: MetadataSchema, property: SchemaProperty, value: number): string | undefined {
  return schema.enums?.[property.enumType ?? '']?.values.find((v) => v.value === value)?.name;
}

/** Applies `noData`, `default`, normalization, offset and scale to a raw value (JSON or binary). */
export function resolveValue(raw: unknown, property: SchemaProperty, schema: MetadataSchema): unknown {
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (raw === undefined || (property.noData !== undefined && equal(raw, property.noData))) return property.default;
  if (property.type === 'ENUM') {
    const map = (v: unknown) => (typeof v === 'number' ? enumName(schema, property, v) : v);
    return Array.isArray(raw) ? raw.map(map) : map(raw);
  }
  if (property.type === 'STRING' || property.type === 'BOOLEAN') return raw;
  const count = COUNTS[property.type] ?? 1;
  const map = (v: unknown, i: number) => (typeof v === 'number' ? transform(v, i, property) : v);
  if (!Array.isArray(raw)) return map(raw, 0);
  if (count === 1) return raw.map((v) => map(v, 0));
  return raw.map((v, i) => (Array.isArray(v) ? v.map((c, j) => map(c, j)) : map(v, i % count)));
}

/**
 * Resolves a JSON metadata entity (`{ class, properties }`) against the schema: every class property, with its
 * default when absent. Unknown classes yield the raw properties.
 */
export function resolveEntity(entity: unknown, schema: MetadataSchema | undefined): Record<string, unknown> {
  if (entity === null || typeof entity !== 'object') return {};
  const { class: className, properties = {} } = entity as { class?: unknown; properties?: Record<string, unknown> };
  const definition = schema?.classes?.[String(className)]?.properties;
  if (definition === undefined || schema === undefined) return { ...properties };
  const out: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(definition)) {
    const value = resolveValue(properties[name], property, schema);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/** One property of a property table: buffer views of values and, for strings and variable arrays, offsets. */
interface TableProperty {
  readonly values?: number;
  readonly arrayOffsets?: number;
  readonly stringOffsets?: number;
  readonly arrayOffsetType?: string;
  readonly stringOffsetType?: string;
}

/** A property table of a subtree. */
export interface PropertyTable {
  readonly class: string;
  readonly count: number;
  readonly properties: Readonly<Record<string, TableProperty>>;
}

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const decoder = new TextDecoder();

function offsetAt(bytes: Uint8Array | undefined, index: number, type = 'UINT32'): number | undefined {
  const component = COMPONENTS[type];
  if (bytes === undefined || component === undefined || (index + 1) * component.size > bytes.length) return undefined;
  return readComponent(view(bytes), index * component.size, type);
}

function elementBytes(property: SchemaProperty): number {
  if (property.type === 'BOOLEAN' || property.type === 'STRING') return 0;
  const type = property.type === 'ENUM' ? 'UINT16' : (property.componentType ?? '');
  return (COMPONENTS[type]?.size ?? 0) * (COUNTS[property.type] ?? 1);
}

function readElements(
  values: Uint8Array,
  property: SchemaProperty,
  first: number,
  count: number,
): unknown[] | undefined {
  const component = property.type === 'ENUM' ? 'UINT16' : (property.componentType ?? '');
  const size = COMPONENTS[component]?.size ?? 0;
  const perElement = COUNTS[property.type] ?? 1;
  if (size === 0 || (first + count) * size * perElement > values.length) return undefined;
  const v = view(values);
  return Array.from({ length: count }, (_, e) => {
    const components = Array.from({ length: perElement }, (_, c) =>
      readComponent(v, (first + e) * size * perElement + c * size, component),
    );
    return perElement === 1 ? components[0] : components;
  });
}

function readRaw(index: number, p: TableProperty, property: SchemaProperty, views: readonly Uint8Array[]): unknown {
  const values = p.values === undefined ? undefined : views[p.values];
  if (values === undefined) return undefined;
  const arrays = p.arrayOffsets === undefined ? undefined : views[p.arrayOffsets];
  const fixed = property.array === true && arrays === undefined ? (property.count ?? 0) : undefined;
  let first = index;
  let count = 1;
  if (property.array === true) {
    const start = fixed !== undefined ? index * fixed : offsetAt(arrays, index, p.arrayOffsetType);
    const end =
      fixed !== undefined && start !== undefined ? start + fixed : offsetAt(arrays, index + 1, p.arrayOffsetType);
    if (start === undefined || end === undefined || end < start) return undefined;
    first = start;
    count = end - start;
  }
  if (property.type === 'BOOLEAN') {
    const bits = Array.from({ length: count }, (_, i) => ((values[(first + i) >> 3] ?? 0) >> ((first + i) & 7)) & 1);
    return property.array === true ? bits.map(Boolean) : Boolean(bits[0]);
  }
  if (property.type === 'STRING') {
    const offsets = p.stringOffsets === undefined ? undefined : views[p.stringOffsets];
    const strings = Array.from({ length: count }, (_, i) => {
      const s = offsetAt(offsets, first + i, p.stringOffsetType);
      const e = offsetAt(offsets, first + i + 1, p.stringOffsetType);
      return s === undefined || e === undefined || e < s || e > values.length
        ? undefined
        : decoder.decode(values.subarray(s, e));
    });
    if (strings.includes(undefined)) return undefined;
    return property.array === true ? strings : strings[0];
  }
  if (elementBytes(property) === 0) return undefined;
  const elements = readElements(values, property, first, count);
  return elements === undefined ? undefined : property.array === true ? elements : elements[0];
}

/** The resolved properties of one row of a property table. */
export function propertyTableRow(
  table: PropertyTable,
  index: number,
  views: readonly Uint8Array[],
  schema: MetadataSchema,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const definition = schema.classes?.[table.class]?.properties;
  if (definition === undefined || !Number.isInteger(index) || index < 0 || index >= table.count) return out;
  for (const [name, property] of Object.entries(definition)) {
    const p = table.properties[name];
    const value = resolveValue(p === undefined ? undefined : readRaw(index, p, property, views), property, schema);
    if (value !== undefined) out[name] = value;
  }
  return out;
}
