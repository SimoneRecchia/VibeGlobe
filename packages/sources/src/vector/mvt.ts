// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { PbfReader } from 'pbf';

/** A decoded Mapbox Vector Tile (specification 2.1): its layers in file order. */
export interface MvtTile {
  readonly layers: readonly MvtLayer[];
  /** Recoverable problems: features that were dropped, duplicate layers. */
  readonly issues: readonly string[];
}

/** A layer of a vector tile. */
export interface MvtLayer {
  readonly name: string;
  readonly version: number;
  /** Tile coordinates run from 0 to `extent` (4096 by default). */
  readonly extent: number;
  readonly features: readonly MvtFeature[];
}

/** A property value with its type kept: strings, numbers (floats and integers) and booleans. */
export type MvtValue = string | number | boolean;

/** A feature of a layer, its geometry in tile coordinates (extent-scaled, y down). */
export interface MvtFeature {
  readonly id?: number;
  readonly type: 'Unknown' | 'Point' | 'LineString' | 'Polygon';
  /** One part per MoveTo point: single points, lines, or polygon rings (closed). */
  readonly geometry: readonly (readonly [number, number])[][];
  readonly properties: Readonly<Record<string, MvtValue>>;
}

/** Bytes a tile may have before it is refused (bounded work on untrusted input). */
const MAX_TILE_BYTES = 32 * 1024 * 1024;
const TYPES = ['Unknown', 'Point', 'LineString', 'Polygon'] as const;
const VARINT = 0;
const BYTES = 2;

/** A tile the specification calls fatal: the whole tile is no data. */
class FatalError extends Error {}
/** A feature the specification calls recoverable: the feature is dropped. */
class FeatureError extends Error {}

function expectType(pbf: PbfReader, type: number, what: string): void {
  if (pbf.type !== type) throw new FatalError(`${what} has wire type ${pbf.type}`);
}

function readValue(pbf: PbfReader): MvtValue {
  const end = pbf.readVarint() + pbf.pos;
  if (end > pbf.length) throw new FatalError('value runs past the tile');
  let value: MvtValue | undefined;
  let count = 0;
  pbf.readFields(
    (tag) => {
      count++;
      if (tag === 1) value = (expectType(pbf, BYTES, 'string value'), pbf.readString());
      else if (tag === 2) value = (expectType(pbf, 5, 'float value'), pbf.readFloat());
      else if (tag === 3) value = (expectType(pbf, 1, 'double value'), pbf.readDouble());
      else if (tag === 4) value = (expectType(pbf, VARINT, 'int value'), pbf.readVarint(true));
      else if (tag === 5) value = (expectType(pbf, VARINT, 'uint value'), pbf.readVarint());
      else if (tag === 6) value = (expectType(pbf, VARINT, 'sint value'), pbf.readSVarint());
      else if (tag === 7) value = (expectType(pbf, VARINT, 'bool value'), pbf.readBoolean());
      else throw new FatalError(`unknown value type ${tag}`);
    },
    undefined,
    end,
  );
  if (value === undefined || count !== 1) throw new FatalError('a value must have exactly one typed field');
  return value;
}

/** Decodes a geometry command stream, checking it against the specification for the feature's type. */
function decodeGeometry(commands: readonly number[], type: MvtFeature['type']): [number, number][][] {
  const parts: [number, number][][] = [];
  let x = 0;
  let y = 0;
  let i = 0;
  let part: [number, number][] | undefined;
  while (i < commands.length) {
    const command = (commands[i] ?? 0) & 0x7;
    const count = (commands[i++] ?? 0) >>> 3;
    if (command === 7) {
      if (count !== 1) throw new FatalError(`ClosePath with count ${count}`);
      if (type !== 'Polygon' || !part || part.length < 3) throw new FatalError('ClosePath outside a polygon ring');
      part.push(part[0] ?? [0, 0]);
      part = undefined;
      continue;
    }
    if (command !== 1 && command !== 2) throw new FatalError(`unknown command ${command}`);
    const available = Math.floor((commands.length - i) / 2);
    if (count === 0 || available === 0) throw new FatalError(`command count ${count} without parameters`);
    // A point MoveTo whose count exceeds its parameters decodes the points present (fixture 057): bounded allocation.
    if (count > available && !(command === 1 && type === 'Point' && (commands.length - i) % 2 === 0))
      throw new FatalError(`command count ${count} exceeds its parameters`);
    if (command === 2 && !part) throw new FatalError('LineTo before MoveTo');
    if (command === 1 && type !== 'Point' && count !== 1)
      throw new FatalError('MoveTo of a line or ring with several points');
    for (let k = 0; k < Math.min(count, available); k++) {
      const dx = commands[i++] ?? 0;
      const dy = commands[i++] ?? 0;
      x += (dx >>> 1) ^ -(dx & 1);
      y += (dy >>> 1) ^ -(dy & 1);
      if (command === 1) {
        part = [];
        parts.push(part);
      }
      part?.push([x, y]);
    }
  }
  if (type === 'Polygon' && part) throw new FatalError('polygon ring without ClosePath');
  return parts;
}

interface RawFeature {
  id?: number;
  tags?: number[];
  type?: number;
  geometry?: number[];
  geometries: number;
}

function readFeature(pbf: PbfReader): RawFeature {
  const end = pbf.readVarint() + pbf.pos;
  if (end > pbf.length) throw new FatalError('feature runs past the tile');
  const raw: RawFeature = { geometries: 0 };
  pbf.readFields(
    (tag) => {
      if (tag === 1) raw.id = (expectType(pbf, VARINT, 'feature id'), pbf.readVarint());
      else if (tag === 2) raw.tags = (expectType(pbf, BYTES, 'feature tags'), pbf.readPackedVarint());
      else if (tag === 3) raw.type = (expectType(pbf, VARINT, 'feature type'), pbf.readVarint());
      else if (tag === 4) {
        expectType(pbf, BYTES, 'feature geometry');
        raw.geometry = pbf.readPackedVarint();
        raw.geometries++;
      }
    },
    raw,
    end,
  );
  return raw;
}

/** Decodes a geometry; an UNKNOWN feature's geometry cannot be checked, so its errors drop the feature only. */
function decodeUnchecked(commands: readonly number[], type: MvtFeature['type']): [number, number][][] {
  try {
    return decodeGeometry(commands, type);
  } catch (error) {
    if (type === 'Unknown' && error instanceof FatalError) throw new FeatureError(error.message);
    throw error;
  }
}

function buildFeature(raw: RawFeature, keys: readonly string[], values: readonly MvtValue[]): MvtFeature {
  const tags = raw.tags ?? [];
  if (tags.length % 2 !== 0) throw new FeatureError('odd number of tags');
  const properties: Record<string, MvtValue> = {};
  for (let t = 0; t < tags.length; t += 2) {
    const key = keys[tags[t] ?? -1];
    const value = values[tags[t + 1] ?? -1];
    if (key === undefined || value === undefined) throw new FatalError('a tag points past the keys or values');
    properties[key] = value;
  }
  // A missing type is the protobuf default, UNKNOWN: kept, as the specification allows.
  const type = TYPES[raw.type ?? 0];
  if (!type) throw new FeatureError(`unknown geometry type ${raw.type}`);
  if (!raw.geometry || raw.geometries !== 1) throw new FeatureError('feature without exactly one geometry');
  const geometry = decodeUnchecked(raw.geometry, type);
  return { ...(raw.id === undefined ? {} : { id: raw.id }), type, geometry, properties };
}

function readLayer(pbf: PbfReader, issues: string[]): MvtLayer {
  const end = pbf.readVarint() + pbf.pos;
  if (end > pbf.length) throw new FatalError('layer runs past the tile');
  const keys: string[] = [];
  const values: MvtValue[] = [];
  const raws: RawFeature[] = [];
  const layer = { name: '', version: 0, extent: 4096 };
  pbf.readFields(
    (tag) => {
      if (tag === 15) layer.version = (expectType(pbf, VARINT, 'layer version'), pbf.readVarint());
      else if (tag === 1) layer.name = (expectType(pbf, BYTES, 'layer name'), pbf.readString());
      else if (tag === 2) raws.push((expectType(pbf, BYTES, 'feature'), readFeature(pbf)));
      else if (tag === 3) keys.push((expectType(pbf, BYTES, 'key'), pbf.readString()));
      else if (tag === 4) values.push((expectType(pbf, BYTES, 'value'), readValue(pbf)));
      else if (tag === 5) layer.extent = (expectType(pbf, VARINT, 'layer extent'), pbf.readVarint());
    },
    layer,
    end,
  );
  if (layer.name.length === 0) throw new FatalError('layer without a name');
  if (layer.version !== 1 && layer.version !== 2) throw new FatalError(`layer version ${layer.version}`);
  if (!(layer.extent > 0)) throw new FatalError('layer extent is not positive');
  const features: MvtFeature[] = [];
  for (const raw of raws) {
    try {
      features.push(buildFeature(raw, keys, values));
    } catch (error) {
      if (!(error instanceof FeatureError)) throw error;
      issues.push(`${layer.name}: dropped a feature (${error.message})`);
    }
  }
  return { ...layer, features };
}

/**
 * Decodes a Mapbox Vector Tile (F239), validating it against the specification: a tile with a fatal error (wrong wire
 * types, unknown values, tags past the keys or values, malformed geometry commands) is no data (`undefined`), and a
 * feature with a recoverable error is dropped and reported in `issues`. It never throws.
 */
export function decodeMvt(bytes: ArrayBuffer | Uint8Array): MvtTile | undefined {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.byteLength > MAX_TILE_BYTES) return undefined;
  const issues: string[] = [];
  const layers: MvtLayer[] = [];
  try {
    const pbf = new PbfReader(view);
    pbf.readFields((tag) => {
      if (tag !== 3) return;
      expectType(pbf, BYTES, 'layer');
      const layer = readLayer(pbf, issues);
      if (layers.some((l) => l.name === layer.name)) issues.push(`duplicate layer '${layer.name}' ignored`);
      else layers.push(layer);
    }, undefined);
  } catch {
    return undefined;
  }
  return { layers, issues };
}
