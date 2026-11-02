import { describe, expect, it } from 'vitest';
import { applyAlpha, isBlank, waterShare } from './tile-mask.js';

describe('decode-image blank tiles (F618)', () => {
  it('counts a tile as blank only when every pixel is opaque and within the tolerance of the color', () => {
    const tile = (pixel: number[], count = 4): Uint8ClampedArray =>
      new Uint8ClampedArray(Array.from({ length: count }, () => pixel).flat());
    const white = { rgb: [255, 255, 255], tolerance: 2 };
    expect(isBlank(tile([254, 255, 253, 255]), white)).toBe(true);
    expect(isBlank(new Uint8ClampedArray([...tile([255, 255, 255, 255], 3), 200, 255, 255, 255]), white)).toBe(false);
    expect(isBlank(tile([255, 255, 255, 0]), white)).toBe(false);
  });

  it("counts a service's filler with a caption as blank when enough of it is the color (F691)", () => {
    // A grey filler with 4 of 100 pixels of caption, as Esri's "Map data not yet available".
    const filler = new Uint8ClampedArray(
      Array.from({ length: 100 }, (_, i) => (i % 25 === 0 ? [255, 255, 255, 255] : [204, 204, 204, 255])).flat(),
    );
    const grey = { rgb: [204, 204, 204], tolerance: 2 };
    expect(isBlank(filler, grey)).toBe(false);
    expect(isBlank(filler, { ...grey, share: 0.9 })).toBe(true);
    expect(isBlank(filler, { ...grey, share: 0.97 })).toBe(false);
  });
});

describe('the sea key (KB-303)', () => {
  it('keys water of every shade at sea, keeps the colors of land, and inside the land its lakes and shadows', () => {
    // Shallow, medium and deep water, and the package's no-data water.
    const water = [
      [120, 170, 170],
      [50, 95, 125],
      [40, 70, 100],
      [54, 73, 90],
    ] as const;
    // Grass, soil, urban grey, dark forest, snow, snow in shade and a bluish mountain shadow.
    const land = [
      [70, 100, 55],
      [140, 115, 85],
      [128, 128, 128],
      [98, 110, 94],
      [240, 245, 250],
      [200, 220, 245],
      [60, 65, 80],
    ] as const;
    expect(water.map(([r, g, b]) => waterShare(r, g, b))).toEqual([1, 1, 1, 1]);
    expect(land.map(([r, g, b]) => waterShare(r, g, b))).toEqual([0, 0, 0, 0, 0, 0, 0]);
    // At sea: shallow and deep water go, grass stays; inside the land a lake and a shadow stay; where the land's
    // share fades (half, a quarter) the water fades with it.
    const pixels = [...water[0], ...water[2], ...land[0], ...water[2], ...land[6], ...water[1], ...water[1]];
    const rgba = new Uint8Array(pixels.flatMap((c, i) => (i % 3 === 2 ? [c, 255] : [c])));
    applyAlpha(
      rgba,
      new Uint8ClampedArray(7).fill(255),
      undefined,
      new Uint8ClampedArray([0, 0, 0, 255, 255, 128, 64]),
    );
    expect([3, 7, 11, 15, 19, 23, 27].map((i) => rgba[i])).toEqual([0, 0, 255, 255, 255, 128, 64]);
  });
});
