import { describe, expect, it } from 'vitest';
import { readLayerJson, readRanges, TerrainAvailability } from './layer-json.js';

const LAYER = {
  tilejson: '2.1.0',
  format: 'quantized-mesh-1.0',
  version: '1.2.0',
  scheme: 'tms',
  tiles: ['{z}/{x}/{y}.terrain?v={version}'],
  projection: 'EPSG:4326',
  minzoom: 0,
  maxzoom: 14,
  extensions: ['octvertexnormals', 'metadata', 'some-future-extension'],
  metadataAvailability: 10,
  available: [
    [{ startX: 0, startY: 0, endX: 1, endY: 0 }],
    [{ startX: 0, startY: 0, endX: 3, endY: 1 }],
    [{ startX: 2, startY: 1, endX: 3, endY: 2 }],
  ],
};

describe('layer.json', () => {
  it('reads the scheme, zoom range, templates, version, extensions and availability (F128)', () => {
    const layer = readLayerJson(LAYER);
    expect(layer.scheme).toBe('geographic');
    expect([layer.minZoom, layer.maxZoom]).toEqual([0, 14]);
    expect(layer.tiles).toEqual(['{z}/{x}/{y}.terrain?v={version}']);
    expect(layer.version).toBe('1.2.0');
    expect(layer.extensions).toContain('some-future-extension');
    expect(layer.metadataEvery).toBe(10);
    expect(layer.available[2]).toEqual([{ startX: 2, startY: 1, endX: 3, endY: 2 }]);
    expect(readLayerJson({ ...LAYER, projection: 'EPSG:3857' }).scheme).toBe('mercator');
  });

  it('answers availability with y from the north, levels listed in full, and metadata from child tiles (F128)', () => {
    const availability = new TerrainAvailability(readLayerJson(LAYER));
    // Level 2 has 4 rows: TMS row 1 is row 2 from the north.
    expect(availability.status(2, 2, 2)).toBe('available');
    expect(availability.status(2, 0, 2)).toBe('unavailable');
    expect(availability.status(15, 0, 0)).toBe('unavailable');
    // Level 3 is not listed: unknown until the metadata of a tile above it arrives.
    expect(availability.status(3, 5, 4)).toBe('unknown');
    availability.addFromMetadata(3, readRanges([[{ startX: 4, startY: 2, endX: 5, endY: 3 }]], 'metadata'));
    expect(availability.status(3, 5, 4)).toBe('available');
  });

  it('rejects documents that are not quantized-mesh terrain or have invalid fields', () => {
    expect(() => readLayerJson({ ...LAYER, format: 'heightmap-1.0' })).toThrow(TypeError);
    expect(() => readLayerJson({ ...LAYER, projection: 'EPSG:2056' })).toThrow(TypeError);
    expect(() => readLayerJson({ ...LAYER, tiles: [] })).toThrow(TypeError);
    expect(() => readLayerJson({ ...LAYER, available: [[{ startX: 3, startY: 0, endX: 1, endY: 0 }]] })).toThrow(
      TypeError,
    );
    expect(() => readLayerJson({ ...LAYER, maxzoom: -1 })).toThrow(TypeError);
  });
});
