import { readdirSync, readFileSync } from 'node:fs';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { describe, expect, it } from 'vitest';
import { failures, runParserConformance } from '../conformance/index.js';
import { decodeMvt, type MvtTile } from './mvt.js';

const DIR = new URL('../__fixtures__/mvt/', import.meta.url);
const bytes = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(name, DIR)));
const json = (name: string): unknown => JSON.parse(readFileSync(new URL(name, DIR), 'utf8'));

interface RawLayer {
  name: string;
  version?: number;
  extent?: number;
  keys: string[];
  values: Record<string, unknown>[];
  features: { id?: number; tags: number[]; type: number }[];
}

const TYPES = ['Unknown', 'Point', 'LineString', 'Polygon'];
// Fixtures 051 and 057 hold the same geometry (a MoveTo with a gigantic count and one point) with opposite
// verdicts; the decoder follows 057 (valid: decode the points present without over-allocating).
const CONTRADICTED = new Set(['051']);

/** The specification fixtures with their verdict: valid tiles must match the recorded tile, fatal ones are no data. */
function specFixtures() {
  return readdirSync(DIR)
    .filter((n) => /^\d{3}\.mvt$/.test(n))
    .sort()
    .map((name) => {
      const id = name.slice(0, 3);
      const info = json(`${id}.info.json`) as { validity: { v2: boolean; error?: string } };
      const verdict = info.validity.v2 ? 'valid' : (info.validity.error ?? 'invalid');
      return {
        id,
        input: bytes(name),
        verdict,
        expected: info.validity.v2 ? (json(`${id}.json`) as { layers?: RawLayer[] }) : undefined,
      };
    });
}

/** Differences between a decoded tile and the fixture's recorded protobuf content (layers, ids, types, properties). */
function compare(tile: MvtTile, expected: { layers?: RawLayer[] }): string | undefined {
  const layers = expected.layers ?? [];
  if (tile.layers.length !== layers.length) return `${tile.layers.length} layers, expected ${layers.length}`;
  for (const [i, raw] of layers.entries()) {
    const layer = tile.layers[i];
    if (
      !layer ||
      layer.name !== raw.name ||
      layer.version !== (raw.version ?? 1) ||
      layer.extent !== (raw.extent ?? 4096)
    )
      return `layer ${i} header differs`;
    if (layer.features.length !== raw.features.length) return `layer ${raw.name}: feature count differs`;
    for (const [j, f] of raw.features.entries()) {
      const feature = layer.features[j];
      const properties: Record<string, unknown> = {};
      for (let t = 0; t < f.tags.length; t += 2)
        properties[raw.keys[f.tags[t] ?? 0] ?? ''] = Object.values(raw.values[f.tags[t + 1] ?? 0] ?? {})[0];
      if (feature?.id !== f.id || feature?.type !== TYPES[f.type]) return `feature ${j}: id or type differs`;
      for (const [key, value] of Object.entries(properties)) {
        const got = feature?.properties[key];
        const same =
          typeof value === 'number' && typeof got === 'number' ? Math.abs(got - value) < 1e-6 : got === value;
        if (!same) return `feature ${j}: property ${key} is ${String(got)}, expected ${String(value)}`;
      }
    }
  }
  return undefined;
}

describe('decodeMvt (F239)', () => {
  it('passes the MVT conformance suite on the specification fixtures', async () => {
    const results = await runParserConformance({
      name: 'mvt',
      parse: (input: Uint8Array) => decodeMvt(input),
      fixtures: specFixtures().map((f) => ({
        name: `fixture ${f.id} (${f.verdict})`,
        input: f.input,
        expect: (tile: MvtTile | undefined) => {
          if (f.verdict === 'fatal' && !CONTRADICTED.has(f.id))
            return tile === undefined ? undefined : 'a fatal tile decoded';
          if (f.verdict !== 'valid') return undefined;
          return tile && f.expected ? compare(tile, f.expected) : 'a valid tile was refused';
        },
      })),
      fuzzRuns: 40,
    });
    expect(failures(results)).toEqual([]);
  });

  it('decodes geometry commands into extent-scaled tile coordinates', () => {
    const geometry = (id: string) => decodeMvt(bytes(`${id}.mvt`))?.layers[0]?.features[0]?.geometry;
    expect(geometry('017')).toEqual([[[25, 17]]]);
    expect(geometry('018')).toEqual([
      [
        [2, 2],
        [2, 10],
        [10, 10],
      ],
    ]);
    expect(geometry('019')).toEqual([
      [
        [3, 6],
        [8, 12],
        [20, 34],
        [3, 6],
      ],
    ]);
    expect(geometry('020')).toEqual([[[5, 7]], [[3, 2]]]);
    expect(geometry('021')).toEqual([
      [
        [2, 2],
        [2, 10],
        [10, 10],
      ],
      [
        [1, 1],
        [3, 5],
      ],
    ]);
    expect(geometry('022')?.length).toBe(3);
    const values = decodeMvt(bytes('038.mvt'))?.layers[0]?.features[0]?.properties;
    expect(values).toMatchObject({
      string_value: 'ello',
      bool_value: true,
      int_value: 6,
      double_value: 1.23,
      sint_value: -87948,
      uint_value: 87948,
    });
    expect(values?.['float_value']).toBeCloseTo(3.1, 5);
  });

  it.each(['real-bangkok-12-3188-1888.mvt', 'real-chicago-13-2098-3045.mvt', 'real-sanfrancisco-15-5238-12666.mvt'])(
    'decodes the recorded real-world tile %s like an independent decoder',
    (name) => {
      const input = bytes(name);
      const tile = decodeMvt(input);
      const reference = new VectorTile(new PbfReader(input));
      expect(tile?.layers.map((l) => l.name).sort()).toEqual(Object.keys(reference.layers).sort());
      for (const layer of tile?.layers ?? []) {
        const other = reference.layers[layer.name];
        expect(layer.features.length).toBe(other?.length);
        layer.features.forEach((feature, i) => {
          const ref = other?.feature(i);
          expect([feature.id, feature.type, feature.properties]).toEqual([
            ref?.id,
            TYPES[ref?.type ?? 0],
            { ...ref?.properties },
          ]);
          const parts = ref?.loadGeometry().map((part) => part.map((p): [number, number] => [p.x, p.y]));
          // Both decoders close polygon rings by repeating the first point.
          expect(feature.geometry).toEqual(parts);
        });
      }
    },
  );
});
