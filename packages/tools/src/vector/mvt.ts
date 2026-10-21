/**
 * Mapbox Vector Tile 2.1 encoding (https://github.com/mapbox/vector-tile-spec/tree/master/2.1), written from the
 * specification, and a decoder used by the tests.
 */
import { ProtoReader, ProtoWriter } from './protobuf.js';

/** Tile extent in integer units. */
export const EXTENT = 4096;

/** A feature in tile units. */
export interface TileFeature {
  id: number;
  /** 1 point, 2 line, 3 polygon. */
  type: 1 | 2 | 3;
  /** Parts: points (one part of one point), lines, or rings (outer clockwise in tile coordinates, y down). */
  parts: [number, number][][];
  properties: Record<string, string | number>;
}

function command(id: number, count: number): number {
  return (id & 7) | (count << 3);
}

function zigzag(n: number): number {
  return n < 0 ? -n * 2 - 1 : n * 2;
}

/** Encodes geometry commands of one feature. */
function geometry(feature: TileFeature): number[] {
  const out: number[] = [];
  let cx = 0;
  let cy = 0;
  for (const part of feature.parts) {
    const points = feature.type === 3 ? part.slice(0, -1) : part;
    points.forEach(([x, y], i) => {
      if (i === 0) out.push(command(1, 1));
      else if (i === 1) out.push(command(2, points.length - 1));
      out.push(zigzag(x - cx), zigzag(y - cy));
      cx = x;
      cy = y;
    });
    if (feature.type === 3) out.push(command(7, 1));
  }
  return out;
}

/** Encodes one layer. */
function encodeLayer(name: string, features: TileFeature[]): Uint8Array {
  const keys: string[] = [];
  const values: (string | number)[] = [];
  const index = <T>(list: T[], item: T): number => {
    const found = list.indexOf(item);
    return found >= 0 ? found : list.push(item) - 1;
  };
  const layer = new ProtoWriter().uint(15, 2).string(1, name);
  for (const feature of features) {
    const tags: number[] = [];
    for (const key of Object.keys(feature.properties).sort()) {
      tags.push(index(keys, key), index(values, feature.properties[key] as string | number));
    }
    const encoded = new ProtoWriter().uint(1, feature.id).packed(2, tags, false).uint(3, feature.type);
    layer.raw(2, encoded.packed(4, geometry(feature), false).finish());
  }
  for (const key of keys) layer.string(3, key);
  for (const value of values) {
    const v = new ProtoWriter();
    if (typeof value === 'string') v.string(1, value);
    else if (Number.isInteger(value)) v.sint(6, value);
    else v.double(3, value);
    layer.raw(4, v.finish());
  }
  return layer.uint(5, EXTENT).finish();
}

/** Encodes a tile from layers (empty layers are left out, layer order is kept). */
export function encodeTile(layers: [string, TileFeature[]][]): Uint8Array {
  const tile = new ProtoWriter();
  for (const [name, features] of layers) if (features.length > 0) tile.raw(3, encodeLayer(name, features));
  return tile.finish();
}

function decodeValue(reader: ProtoReader): string | number {
  let value: string | number = '';
  reader.forEach((tag, wire) => {
    if (tag === 1) value = reader.string();
    else if (tag === 3) {
      value = new DataView(reader.buf.buffer, reader.buf.byteOffset + reader.pos, 8).getFloat64(0, true);
      reader.pos += 8;
    } else if (tag === 6) value = reader.svarint();
    else if (tag === 4 || tag === 5) value = reader.varint();
    else reader.skip(wire);
  });
  return value;
}

function decodeGeometry(commands: number[]): [number, number][][] {
  const parts: [number, number][][] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < commands.length;) {
    const id = (commands[i] ?? 0) & 7;
    const count = (commands[i++] ?? 0) >> 3;
    if (id === 7) {
      const part = parts[parts.length - 1];
      if (part?.[0]) part.push(part[0]);
      continue;
    }
    for (let k = 0; k < count; k++) {
      const dx = commands[i++] ?? 0;
      const dy = commands[i++] ?? 0;
      x += dx % 2 ? -(dx + 1) / 2 : dx / 2;
      y += dy % 2 ? -(dy + 1) / 2 : dy / 2;
      if (id === 1) parts.push([[x, y]]);
      else parts[parts.length - 1]?.push([x, y]);
    }
  }
  return parts;
}

/** Decodes a tile into layers of features (properties resolved). */
export function decodeTile(bytes: Uint8Array): Record<string, { extent: number; features: TileFeature[] }> {
  const layers: Record<string, { extent: number; features: TileFeature[] }> = {};
  const tile = new ProtoReader(bytes);
  tile.forEach((tag, wire) => {
    if (tag !== 3) return tile.skip(wire);
    const layer = tile.message();
    let name = '';
    let extent = 4096;
    const keys: string[] = [];
    const values: (string | number)[] = [];
    const raw: { id: number; type: number; tags: number[]; geometry: number[] }[] = [];
    layer.forEach((t, w) => {
      if (t === 1) name = layer.string();
      else if (t === 3) keys.push(layer.string());
      else if (t === 4) values.push(decodeValue(layer.message()));
      else if (t === 5) extent = layer.varint();
      else if (t === 2) {
        const f = layer.message();
        const item = { id: 0, type: 0, tags: [] as number[], geometry: [] as number[] };
        f.forEach((ft, fw) => {
          if (ft === 1) item.id = f.varint();
          else if (ft === 2) item.tags = f.packed(false);
          else if (ft === 3) item.type = f.varint();
          else if (ft === 4) item.geometry = f.packed(false);
          else f.skip(fw);
        });
        raw.push(item);
      } else layer.skip(w);
    });
    const features = raw.map((f) => {
      const properties: Record<string, string | number> = {};
      for (let i = 0; i + 1 < f.tags.length; i += 2)
        properties[keys[f.tags[i] ?? 0] ?? ''] = values[f.tags[i + 1] ?? 0] ?? '';
      return { id: f.id, type: f.type as 1 | 2 | 3, parts: decodeGeometry(f.geometry), properties };
    });
    layers[name] = { extent, features };
  });
  return layers;
}
