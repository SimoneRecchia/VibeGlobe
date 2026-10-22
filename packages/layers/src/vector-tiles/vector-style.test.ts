import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { LayerFader } from './layer-fader.js';
import { StyleLayer, type StyleFeatureInput } from './style-layer.js';
import { changeNeedsRelayout, VectorStyle, type StyleChange } from './vector-style.js';

const STYLE = {
  version: 8,
  name: 'fixture',
  sources: { osm: { type: 'vector', tiles: ['https://tiles.example/{z}/{x}/{y}.pbf'], maxzoom: 14 } },
  sprite: 'https://tiles.example/sprite',
  glyphs: 'https://tiles.example/fonts/{fontstack}/{range}.pbf',
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': '#f8f4f0' } },
    { id: 'water', type: 'fill', source: 'osm', 'source-layer': 'water', paint: { 'fill-color': '#a0c8f0' } },
    {
      id: 'roads',
      type: 'line',
      source: 'osm',
      'source-layer': 'transportation',
      minzoom: 5,
      maxzoom: 16,
      filter: ['==', ['get', 'class'], 'primary'],
      paint: { 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1, 15, 11] },
    },
  ],
};

const road = (props: Record<string, unknown>): StyleFeatureInput => ({ type: 'LineString', properties: props });

/** Evaluates an expression as a `circle-radius`-like number or a `circle-color`-like value at a zoom. */
function evaluate(property: string, value: unknown, zoom: number, feature = road({}), state?: Record<string, unknown>) {
  const layer = new StyleLayer({ id: 'x', type: 'circle', source: 's', paint: { [property]: value } });
  expect(layer.problems).toEqual([]);
  return layer.paint(property, zoom, feature, state);
}

describe('expressions follow the style specification (F446)', () => {
  it('evaluates every operator family', () => {
    const f = road({ kind: 'b', n: 4, s: 'Milano', flag: true });
    // lookup
    expect(evaluate('circle-radius', ['get', 'n'], 0, f)).toBe(4);
    expect(evaluate('circle-radius', ['case', ['has', 'missing'], 1, 2], 0, f)).toBe(2);
    // decision
    expect(evaluate('circle-radius', ['match', ['get', 'kind'], 'a', 1, 'b', 2, 0], 0, f)).toBe(2);
    expect(evaluate('circle-radius', ['case', ['all', ['>', ['get', 'n'], 3], ['get', 'flag']], 10, 0], 0, f)).toBe(10);
    // ramps and interpolation
    expect(evaluate('circle-radius', ['step', ['get', 'n'], 1, 3, 5], 0, f)).toBe(5);
    expect(evaluate('circle-radius', ['interpolate', ['exponential', 2], ['zoom'], 0, 0, 2, 3], 1)).toBe(1);
    // math
    expect(evaluate('circle-radius', ['+', ['*', ['get', 'n'], 2], ['sqrt', 9], ['%', 7, 4]], 0, f)).toBe(14);
    expect(evaluate('circle-radius', ['max', ['min', 5, ['ln2']], ['abs', -1]], 0, f)).toBe(1);
    // string
    expect(evaluate('circle-radius', ['length', ['concat', ['upcase', ['get', 's']], '!']], 0, f)).toBe(7);
    // color
    expect(evaluate('circle-color', ['rgba', 255, 0, 0, 0.5], 0, f)).toEqual({ r: 1, g: 0, b: 0, a: 0.5 });
    expect(evaluate('circle-color', ['interpolate', ['linear'], ['zoom'], 0, 'black', 10, 'white'], 5)).toEqual({
      r: expect.closeTo(0.5, 5) as number,
      g: expect.closeTo(0.5, 5) as number,
      b: expect.closeTo(0.5, 5) as number,
      a: 1,
    });
    // type conversion
    expect(evaluate('circle-radius', ['to-number', '12'], 0, f)).toBe(12);
    expect(evaluate('circle-radius', ['coalesce', ['get', 'missing'], 3], 0, f)).toBe(3);
    // zoom
    expect(evaluate('circle-radius', ['step', ['zoom'], 1, 7, 2, 8, 3], 7.25)).toBe(2);
    // feature-state
    const hover = ['case', ['boolean', ['feature-state', 'hover'], false], 9, 1];
    expect(evaluate('circle-radius', hover, 0, f)).toBe(1);
    expect(evaluate('circle-radius', hover, 0, f, { hover: true })).toBe(9);
  });

  it('selects the same features with legacy and expression filters', () => {
    const pairs: [unknown, unknown][] = [
      [
        ['==', 'class', 'primary'],
        ['==', ['get', 'class'], 'primary'],
      ],
      [
        ['in', 'class', 'primary', 'secondary'],
        ['in', ['get', 'class'], ['literal', ['primary', 'secondary']]],
      ],
      [
        ['all', ['>=', 'rank', 2], ['!has', 'tunnel']],
        ['all', ['>=', ['get', 'rank'], 2], ['!', ['has', 'tunnel']]],
      ],
      [
        ['==', '$type', 'LineString'],
        ['==', ['geometry-type'], 'LineString'],
      ],
    ];
    const features = [
      road({ class: 'primary', rank: 1 }),
      road({ class: 'secondary', rank: 3 }),
      road({ class: 'primary', rank: 5, tunnel: 1 }),
      { type: 'Polygon', properties: { class: 'primary', rank: 2 } },
    ];
    for (const [legacy, current] of pairs) {
      const a = new StyleLayer({ id: 'a', type: 'line', source: 's', filter: legacy });
      const b = new StyleLayer({ id: 'b', type: 'line', source: 's', filter: current });
      expect(a.problems).toEqual([]);
      expect(features.map((f) => a.filter(10, f))).toEqual(features.map((f) => b.filter(10, f)));
    }
  });

  it('interpolates zoom-dependent paint continuously, without steps at integer zooms', () => {
    const roads = VectorStyle.load(STYLE).layer('roads');
    let previous = Number(roads?.paint('line-width', 10));
    for (let zoom = 10.01; zoom <= 15; zoom += 0.01) {
      const width = Number(roads?.paint('line-width', zoom));
      expect(width - previous).toBeGreaterThan(0);
      expect(width - previous).toBeLessThan(0.0101);
      previous = width;
    }
  });
});

describe('layer order, zoom ranges and visibility (F447)', () => {
  it('keeps the style order and the specification zoom range semantics', () => {
    const style = VectorStyle.load(STYLE);
    expect(style.layers.map((l) => l.id)).toEqual(['background', 'water', 'roads']);
    const roads = style.layer('roads');
    expect([4.99, 5, 15.99, 16].map((z) => roads?.inZoomRange(z))).toEqual([false, true, true, false]);
    expect(style.layersFor('osm', 'transportation').map((l) => l.id)).toEqual(['roads']);
  });

  it('fades a layer across its minzoom and on a visibility change instead of popping', () => {
    const style = VectorStyle.load(STYLE);
    const fader = new LayerFader(300);
    expect(fader.update(0, 4, style.layers).get('roads')).toBe(0);
    const seen: number[] = [];
    for (let t = 16; t <= 400; t += 16) seen.push(fader.update(t, 5.5, style.layers).get('roads') ?? -1);
    expect(seen[0]).toBeGreaterThan(0);
    expect(seen[0]).toBeLessThan(0.1);
    expect(Math.max(...seen.slice(1).map((v, i) => v - (seen[i] ?? 0)))).toBeLessThan(0.06);
    expect(seen.at(-1)).toBe(1);
    style.setVisibility('roads', false);
    expect(fader.update(416, 5.5, style.layers).get('roads')).toBeCloseTo(1 - 16 / 300, 6);
    expect(fader.fading(5.5, style.layers)).toBe(true);
  });
});

describe('runtime style changes (F450)', () => {
  it('reports each change with its cost and never asks for a tile download', () => {
    const style = VectorStyle.load(STYLE);
    const changes: StyleChange[] = [];
    style.onChange((c) => changes.push(c));
    expect(style.setPaintProperty('water', 'fill-color', '#00f')).toBeUndefined();
    expect(style.layer('water')?.paint('fill-color', 3)).toEqual({ r: 0, g: 0, b: 1, a: 1 });
    expect(style.setLayoutProperty('roads', 'line-cap', 'round')).toBeUndefined();
    expect(style.setFilter('roads', ['==', ['get', 'class'], 'secondary'])).toBeUndefined();
    expect(style.layer('roads')?.filter(8, road({ class: 'secondary' }))).toBe(true);
    expect(style.addLayer({ id: 'rail', type: 'line', source: 'osm', 'source-layer': 'rail' }, 'roads')).toEqual([]);
    expect(style.removeLayer('water')).toBe(true);
    expect(style.layers.map((l) => l.id)).toEqual(['background', 'rail', 'roads']);
    expect(changes.map((c) => [c.kind, changeNeedsRelayout(c)])).toEqual([
      ['paint', false],
      ['layout', true],
      ['filter', true],
      ['order', true],
      ['order', true],
    ]);
    expect(style.serialize()['layers']).toHaveLength(3);
  });

  it('refuses invalid changes and keeps the previous value', () => {
    const style = VectorStyle.load(STYLE);
    expect(style.setPaintProperty('water', 'fill-color', 42)?.path).toBe('water.paint.fill-color');
    expect(style.layer('water')?.paint('fill-color', 0)).toEqual({ r: 160 / 255, g: 200 / 255, b: 240 / 255, a: 1 });
    expect(style.setFilter('roads', ['bogus-operator'])?.path).toBe('roads.filter');
    expect(style.addLayer({ id: 'x', type: 'line', source: 'missing' })[0]?.message).toContain('not found');
    expect(style.setPaintProperty('nope', 'fill-color', 'red')?.message).toContain('no layer');
  });
});

describe('validation on load (F451)', () => {
  it('reports each problem with its JSON path and keeps the valid layers', () => {
    const broken = structuredClone(STYLE) as { layers: Record<string, unknown>[] };
    broken.layers.push(
      {
        id: 'typo',
        type: 'fill',
        source: 'osm',
        'source-layer': 'w',
        paint: { 'fill-colr': 'red', 'fill-opacity': 0.5 },
      },
      { id: 'wrong-type', type: 'fill', source: 'osm', 'source-layer': 'w', paint: { 'fill-opacity': 'high' } },
      { id: 'orphan', type: 'line', source: 'missing', 'source-layer': 'r' },
    );
    const style = VectorStyle.load(broken);
    expect(style.problems.map((p) => p.path)).toEqual([
      'layers[3].paint.fill-colr',
      'layers[4].paint.fill-opacity',
      'layers[5]',
    ]);
    expect(style.problems[2]?.message).toContain('source "missing" not found');
    expect(style.layers.map((l) => l.id)).toEqual(['background', 'water', 'roads', 'typo', 'wrong-type']);
    expect(style.layer('typo')?.paint('fill-opacity', 0)).toBe(0.5);
    expect(style.layer('wrong-type')?.paint('fill-opacity', 0)).toBe(1);
  });

  it('never throws on malformed input', () => {
    for (const input of [null, 3, 'style', [], { version: 8 }, { layers: 'x' }]) {
      const style = VectorStyle.load(input);
      expect(style.problems.length).toBeGreaterThan(0);
    }
  });

  const leaf = fc.oneof(
    fc.string(),
    fc.double(),
    fc.boolean(),
    fc.constant(null),
    fc.array(fc.string(), { maxLength: 3 }),
  );
  test.prop([fc.array(fc.tuple(fc.nat(40), fc.string({ maxLength: 12 }), leaf), { minLength: 1, maxLength: 6 })], {
    numRuns: 150,
  })('a randomly mutated style loads without an exception and keeps a drawable layer list', (mutations) => {
    const style = structuredClone(STYLE) as unknown as Record<string, unknown>;
    for (const [where, key, value] of mutations) {
      const targets = collectObjects(style);
      const target = targets[where % targets.length];
      if (target !== undefined) target[key === '' ? 'id' : key] = value;
    }
    const loaded = VectorStyle.load(style);
    for (const layer of loaded.layers) {
      expect(() => layer.paint(`${layer.type}-opacity`, 10)).not.toThrow();
      expect(() => layer.filter(10, road({ class: 'primary' }))).not.toThrow();
    }
  });
});

function collectObjects(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (value !== null && typeof value === 'object') {
    if (!Array.isArray(value)) out.push(value as Record<string, unknown>);
    for (const child of Object.values(value)) collectObjects(child, out);
  }
  return out;
}
