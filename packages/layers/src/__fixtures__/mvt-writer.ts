/** A minimal Mapbox Vector Tile encoder for tests (MVT 2.1): one geometry part list per feature. */
import { PbfWriter } from 'pbf';

/** A feature to encode, coordinates in tile units. */
export interface FixtureFeature {
  readonly id?: number;
  readonly type: 'Point' | 'LineString' | 'Polygon';
  readonly geometry: readonly (readonly (readonly [number, number])[])[];
  readonly properties: Readonly<Record<string, string | number | boolean>>;
}

const zigzag = (n: number): number => (n << 1) ^ (n >> 31);

function commands(feature: FixtureFeature): number[] {
  const out: number[] = [];
  let x = 0;
  let y = 0;
  for (const part of feature.geometry) {
    const points = feature.type === 'Polygon' ? part.slice(0, -1) : part;
    points.forEach(([px, py], i) => {
      if (i === 0) out.push((1 << 3) | 1);
      else if (i === 1) out.push(((points.length - 1) << 3) | 2);
      out.push(zigzag(Math.round(px) - x), zigzag(Math.round(py) - y));
      x = Math.round(px);
      y = Math.round(py);
    });
    if (feature.type === 'Polygon') out.push((1 << 3) | 7);
  }
  return out;
}

/** Encodes layers of features into tile bytes. */
export function encodeMvt(layers: Readonly<Record<string, readonly FixtureFeature[]>>, extent = 4096): ArrayBuffer {
  const pbf = new PbfWriter();
  for (const [name, features] of Object.entries(layers)) {
    const keys: string[] = [];
    const values: (string | number | boolean)[] = [];
    pbf.writeMessage(
      3,
      (_: unknown, w: PbfWriter) => {
        w.writeVarintField(15, 2);
        w.writeStringField(1, name);
        for (const feature of features) {
          w.writeMessage(
            2,
            (__: unknown, f: PbfWriter) => {
              if (feature.id !== undefined) f.writeVarintField(1, feature.id);
              const tags: number[] = [];
              for (const [key, value] of Object.entries(feature.properties)) {
                if (!keys.includes(key)) keys.push(key);
                if (!values.includes(value)) values.push(value);
                tags.push(keys.indexOf(key), values.indexOf(value));
              }
              f.writePackedVarint(2, tags);
              f.writeVarintField(3, ['Unknown', 'Point', 'LineString', 'Polygon'].indexOf(feature.type));
              f.writePackedVarint(4, commands(feature));
            },
            undefined,
          );
        }
        for (const key of keys) w.writeStringField(3, key);
        for (const value of values) {
          w.writeMessage(
            4,
            (___: unknown, v: PbfWriter) => {
              if (typeof value === 'string') v.writeStringField(1, value);
              else if (typeof value === 'boolean') v.writeBooleanField(7, value);
              else if (Number.isInteger(value)) v.writeSVarintField(6, value);
              else v.writeDoubleField(3, value);
            },
            undefined,
          );
        }
        w.writeVarintField(5, extent);
      },
      undefined,
    );
  }
  const bytes = pbf.finish();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
