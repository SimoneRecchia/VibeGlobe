import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { encodeJpeg } from './jpeg.js';
import { decodePng, encodePng } from './png.js';
import { TERRARIUM_STEP_M, encodeTerrariumTile, terrariumHeight } from './terrarium.js';

describe('encoders', () => {
  it('encodes PNG that an independent decoder reads back exactly, deterministically', () => {
    const pixels = Uint8Array.from({ length: 16 * 8 * 3 }, (_, i) => (i * 37) & 255);
    const png = encodePng(pixels, 16, 8, 3);
    const decoded = PNG.sync.read(Buffer.from(png));
    const rgb = [...decoded.data].filter((_, i) => i % 4 !== 3);
    expect(rgb).toEqual([...pixels]);
    expect(encodePng(pixels, 16, 8, 3)).toEqual(png);
  });

  it('encodes Terrarium heights within half a quantization step', () => {
    const heights = Float32Array.from([-10994.5, -0.001, 0, 0.3, 4808.73, 8848.86]);
    const decoded = decodePng(
      encodeTerrariumTile(
        Float32Array.from({ length: 64 }, (_, i) => heights[i % 6] ?? 0),
        8,
      ),
    );
    for (let i = 0; i < 64; i++) {
      const p = decoded.pixels.subarray(i * 3, i * 3 + 3);
      const height = terrariumHeight(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0);
      expect(Math.abs(height - (heights[i % 6] ?? 0))).toBeLessThanOrEqual(TERRARIUM_STEP_M / 2 + 1e-4);
    }
  });

  it('writes a well-formed baseline JPEG (SOI, DQT, SOF0, DHT, SOS, EOI), deterministically', () => {
    const rgb = Uint8Array.from({ length: 24 * 16 * 3 }, (_, i) => (i * 13) & 255);
    const jpeg = encodeJpeg(rgb, 24, 16, 85);
    const markers: number[] = [];
    for (let i = 0; i + 1 < jpeg.length; i++)
      if (jpeg[i] === 0xff && (jpeg[i + 1] ?? 0) >= 0xc0) markers.push(jpeg[i + 1] ?? 0);
    expect(markers.slice(0, 8)).toEqual([0xd8, 0xe0, 0xdb, 0xc0, 0xc4, 0xc4, 0xc4, 0xc4]);
    expect(markers).toContain(0xda);
    expect([...jpeg.subarray(-2)]).toEqual([0xff, 0xd9]);
    expect(encodeJpeg(rgb, 24, 16, 85)).toEqual(jpeg);
  });
});
