import { describe, expect, it } from 'vitest';
import { StyleError, compileStyle, evaluateProperty } from './style.js';

function value(
  kind: Parameters<typeof compileStyle>[0],
  style: Record<string, unknown>,
  name: string,
  zoom: number,
  properties: Record<string, unknown> = {},
): number[] | string {
  const property = compileStyle(kind, style).properties.find((p) => p.name === name);
  if (property === undefined) throw new Error(`no ${name}`);
  const out = new Float64Array(4).fill(NaN);
  const text = evaluateProperty(property, zoom, { type: 'Point', properties }, out, 0);
  return text ?? [...out].filter((v) => !Number.isNaN(v));
}

describe('flat polygons (KB-285)', () => {
  it('extrudes a polygon only when its style sets a height: the specification default of 0 would draw it opaque', () => {
    const flat = compileStyle('polygon', { 'fill-color': '#ff0000', 'fill-opacity': 0.3 });
    expect(flat.properties.map((p) => p.channel)).not.toContain('heightMeters');
    expect(flat.properties.map((p) => p.channel)).not.toContain('baseMeters');
    const raised = compileStyle('polygon', { 'fill-extrusion-height': 12 });
    expect(raised.properties.map((p) => p.channel)).toContain('heightMeters');
  });
});

describe('layer styles (MapLibre expressions)', () => {
  it('derives color, size, width, opacity, icon and text from feature properties (F369)', () => {
    const color = ['match', ['get', 'kind'], 'hot', '#ff0000', 'cold', '#0000ff', '#808080'];
    expect(value('point', { 'circle-color': color }, 'circle-color', 3, { kind: 'cold' })).toEqual([0, 0, 1, 1]);
    expect(value('point', { 'circle-color': ['get', 'c'] }, 'circle-color', 3, { c: 'rgba(255, 0, 0, 0.5)' })).toEqual([
      1, 0, 0, 0.5,
    ]);
    expect(value('point', { 'circle-radius': ['*', 2, ['get', 'r']] }, 'circle-radius', 3, { r: 4 })).toEqual([8]);
    expect(value('polyline', { 'line-width': ['get', 'w'] }, 'line-width', 3, { w: 3 })).toEqual([3]);
    expect(value('polygon', { 'fill-opacity': ['/', ['get', 'p'], 100] }, 'fill-opacity', 3, { p: 25 })).toEqual([
      0.25,
    ]);
    expect(value('marker', { 'icon-image': ['concat', 'pin-', ['get', 'k']] }, 'icon-image', 3, { k: 'a' })).toBe(
      'pin-a',
    );
    expect(value('label', { 'text-field': ['upcase', ['get', 'name']] }, 'text-field', 3, { name: 'Roma' })).toBe(
      'ROMA',
    );
    expect(value('label', { 'text-anchor': 'top-left' }, 'text-anchor', 3)).toEqual([5]);
  });

  it('rejects malformed expressions and unknown properties with clear errors (F369)', () => {
    expect(() => compileStyle('point', { 'circle-color': ['get'] })).toThrow(StyleError);
    expect(() => compileStyle('point', { 'circle-radius': ['zoom'] })).toThrow(/circle-radius.*zoom/);
    expect(() => compileStyle('point', { 'line-width': 2 })).toThrow(/line-width: not a property of point layers/);
    try {
      compileStyle('polyline', { 'line-color': ['nope'], 'line-width': 'wide' });
      expect.unreachable();
    } catch (error) {
      expect((error as StyleError).problems).toHaveLength(2);
    }
  });

  it('interpolates zoom-dependent values continuously and switches steps exactly at their stop (F370)', () => {
    const style = {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 2, 15, 12],
      'circle-opacity': ['step', ['zoom'], 0, 10, 1],
    };
    expect(compileStyle('point', style).zoomDependent).toBe(true);
    let previous = value('point', style, 'circle-radius', 5)[0] as number;
    for (let zoom = 5.01; zoom <= 15; zoom += 0.01) {
      const radius = value('point', style, 'circle-radius', zoom)[0] as number;
      expect(radius - previous).toBeGreaterThan(0);
      expect(radius - previous).toBeLessThan(0.0101);
      previous = radius;
    }
    expect(value('point', style, 'circle-opacity', 9.999)).toEqual([0]);
    expect(value('point', style, 'circle-opacity', 10)).toEqual([1]);
  });
});
