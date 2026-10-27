// A small Mapbox Vector Tile 2.1 encoder for the fixtures (ADR 0131): one layer per name, keys and values shared.
import { ProtoWriter } from './proto.ts';

/** A feature to encode, coordinates in tile units; polygon rings closed. */
export interface FixtureFeature {
  readonly id?: number;
  readonly type: 'Point' | 'LineString' | 'Polygon';
  readonly geometry: readonly (readonly (readonly [number, number])[])[];
  readonly properties: Readonly<Record<string, string | number | boolean>>;
}

const zigzag = (n: number): number => (n << 1) ^ (n >> 31);
const TYPES = ['Unknown', 'Point', 'LineString', 'Polygon'];

function commands(feature: FixtureFeature): number[] {
  const out: number[] = [];
  let cx = 0;
  let cy = 0;
  for (const part of feature.geometry) {
    const points = feature.type === 'Polygon' ? part.slice(0, -1) : part;
    points.forEach(([px, py], i) => {
      const x = Math.round(px);
      const y = Math.round(py);
      if (i === 0) out.push((1 << 3) | 1);
      else if (i === 1) out.push(((points.length - 1) << 3) | 2);
      out.push(zigzag(x - cx), zigzag(y - cy));
      cx = x;
      cy = y;
    });
    if (feature.type === 'Polygon') out.push((1 << 3) | 7);
  }
  return out;
}

function writeValue(value: string | number | boolean, w: ProtoWriter): void {
  if (typeof value === 'string') w.string(1, value);
  else if (typeof value === 'boolean') w.bool(7, value);
  else if (Number.isInteger(value)) w.sint(6, value);
  else w.double(3, value);
}

function writeLayer(name: string, features: readonly FixtureFeature[], extent: number, w: ProtoWriter): void {
  const keys: string[] = [];
  const values: (string | number | boolean)[] = [];
  w.uint(15, 2);
  w.string(1, name);
  for (const feature of features) {
    const tags: number[] = [];
    for (const [key, value] of Object.entries(feature.properties)) {
      if (!keys.includes(key)) keys.push(key);
      if (!values.includes(value)) values.push(value);
      tags.push(keys.indexOf(key), values.indexOf(value));
    }
    w.message(2, (f) => {
      if (feature.id !== undefined) f.uint(1, feature.id);
      f.packed(2, tags);
      f.uint(3, TYPES.indexOf(feature.type));
      f.packed(4, commands(feature));
    });
  }
  for (const key of keys) w.string(3, key);
  for (const value of values) w.message(4, (v) => writeValue(value, v));
  w.uint(5, extent);
}

/** Encodes layers of features into tile bytes. */
export function encodeMvt(layers: Readonly<Record<string, readonly FixtureFeature[]>>, extent = 4096): Uint8Array {
  const pbf = new ProtoWriter();
  for (const [name, features] of Object.entries(layers)) pbf.message(3, (w) => writeLayer(name, features, extent, w));
  return pbf.finish();
}
