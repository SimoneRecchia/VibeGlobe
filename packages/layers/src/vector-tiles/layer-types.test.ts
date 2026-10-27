import { decodeMvt } from '@vibeglobe/sources/vector';
import { describe, expect, it } from 'vitest';
import { encodeMvt } from '../__fixtures__/mvt-writer.js';
import { encodeGeoJsonTile, geojsonShapes } from './geojson-tiles.js';
import { layoutVectorTile } from './layout-tile.js';
import { colorReliefImage, decodeDem, heatmapImage, hillshadeImage } from './raster-images.js';
import { StyleLayer } from './style-layer.js';
import { meshPaint } from './vector-paint.js';

const layer = (json: Record<string, unknown>) => new StyleLayer({ id: 'l', source: 's', ...json } as never);

describe('raster, hillshade and heatmap images (F445)', () => {
  it('decodes terrarium and Mapbox DEM pixels', () => {
    expect([...decodeDem([128, 0, 0, 255], 'terrarium')]).toEqual([0]);
    expect([...decodeDem([1, 134, 160, 255], 'mapbox')]).toEqual([0]);
  });

  it('lights slopes facing the illumination direction and shades the others', () => {
    // A ramp rising to the east: lit from the west (270°) it faces the light, lit from the east it faces away.
    const size = 8;
    const heights = Float32Array.from({ length: size * size }, (_, i) => (i % size) * 500);
    const alpha = (direction: number) => {
      const image = hillshadeImage(
        heights,
        size,
        { z: 12, y: 1450 },
        layer({ type: 'hillshade', paint: { 'hillshade-illumination-direction': direction } }),
        12,
      );
      return [image.data[(4 * size + 4) * 4] ?? 0, image.data[(4 * size + 4) * 4 + 3] ?? 0];
    };
    const [litRed] = alpha(270);
    const [shadedRed, shadedAlpha] = alpha(90);
    expect(litRed).toBeGreaterThan(200);
    expect(shadedRed).toBeLessThan(50);
    expect(shadedAlpha).toBeGreaterThan(100);
  });

  it('colors each pixel of a DEM tile by color-relief-color at its elevation (KB-216)', () => {
    const relief = layer({
      type: 'color-relief',
      paint: { 'color-relief-color': ['interpolate', ['linear'], ['elevation'], 0, '#00ff00', 2000, '#ff0000'] },
    });
    const image = colorReliefImage(Float32Array.of(0, 1000, 2000, 2000), 2, relief, 8);
    const at = (i: number) => [...image.data.slice(i * 4, i * 4 + 4)];
    expect(at(0)).toEqual([0, 255, 0, 255]);
    expect(at(1)[0]).toBeGreaterThan(120);
    expect(at(1)[1]).toBeGreaterThan(120);
    expect(at(2)).toEqual([255, 0, 0, 255]);
  });

  it('sums Gaussian kernels into densities colored by heatmap-color', () => {
    const heat = layer({ type: 'heatmap', paint: { 'heatmap-radius': 40, 'heatmap-intensity': 1 } });
    const image = heatmapImage(
      [
        { x: 2048, y: 2048, weight: 1 },
        { x: 2048, y: 2048, weight: 1 },
      ],
      512,
      heat,
      10,
    );
    const at = (x: number, y: number) => [
      ...image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4),
    ];
    // Two points at the center: density over 1, the ramp's end (red); far away nothing.
    expect(at(64, 64)).toEqual([255, 0, 0, 255]);
    expect(at(2, 2)).toEqual([0, 0, 0, 0]);
  });
});

describe('fill outlines, patterns and line gradients (F445)', () => {
  const square = encodeMvt({
    b: [
      {
        id: 1,
        type: 'Polygon',
        geometry: [
          [
            [100, 100],
            [100, 300],
            [300, 300],
            [300, 100],
            [100, 100],
          ],
        ],
        properties: {},
      },
    ],
  });

  it('lays out an outline bucket for a fill with an outline color, around every edge', () => {
    const buckets = layoutVectorTile({
      bytes: square,
      layers: [{ id: 'f', type: 'fill', source: 's', 'source-layer': 'b', paint: { 'fill-outline-color': '#000' } }],
      zoom: 14,
    });
    expect(buckets.map((b) => b.type)).toEqual(['fill', 'fill-outline']);
    // Four edges of 200 units: the last vertex is 800 units along the ring.
    expect(Math.max(...(buckets[1]?.geometry?.distances ?? []))).toBe(800);
  });

  it('writes a pattern as its atlas texels, and line-gradient colors by line progress', () => {
    const fill = layer({ type: 'fill', paint: { 'fill-pattern': 'hatch' } });
    const pattern = () => ({ x: 10, y: 20, width: 16, height: 16, pixelRatio: 2 });
    const paint = meshPaint(
      fill,
      { features: [{ id: 1, type: 'Polygon', properties: {} }] },
      new Uint32Array(1),
      10,
      () => undefined,
      undefined,
      { pattern },
    );
    expect([...paint.paramsA]).toEqual([10, 20, 16, 16]);
    expect([...paint.colorA]).toEqual([2, -1, 0, 1]);
    const line = layer({
      type: 'line',
      paint: { 'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, '#0000ff', 1, '#ff0000'] },
    });
    const progress = Float32Array.from([0, 1]);
    const gradient = meshPaint(
      line,
      { features: [{ id: 1, type: 'LineString', properties: {} }] },
      new Uint32Array(2),
      10,
      () => undefined,
      undefined,
      { progress },
    );
    expect([...gradient.colorA.slice(0, 4)]).toEqual([0, 0, 1, 1]);
    expect([...gradient.colorA.slice(4, 8)]).toEqual([1, 0, 0, 1]);
  });

  it('gives each GeoJSON line piece its share of the whole line, so progress continues across tiles', () => {
    const shapes = geojsonShapes({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: [
          [-10, 1],
          [10, 1],
        ],
      },
    });
    const pieces = [encodeGeoJsonTile(shapes, 1, 0, 0, true), encodeGeoJsonTile(shapes, 1, 1, 0, true)].map(
      (bytes) => decodeMvt(bytes ?? new ArrayBuffer(0))?.layers[0]?.features[0]?.properties,
    );
    // Each piece runs through its tile's buffer (5.625° at zoom 1) past the edge between the tiles at longitude 0.
    expect(pieces[0]?.['mapbox_clip_start']).toBe(0);
    expect(Number(pieces[0]?.['mapbox_clip_end'])).toBeCloseTo((10 + 5.625) / 20, 2);
    expect(Number(pieces[1]?.['mapbox_clip_start'])).toBeCloseTo((10 - 5.625) / 20, 2);
    expect(Number(pieces[1]?.['mapbox_clip_end'])).toBe(1);
  });
});
