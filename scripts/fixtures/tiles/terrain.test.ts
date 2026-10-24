import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { decodeHeightmap } from '@vibeglobe/core/decoders';
import { decodeQuantizedMesh, rasterizeQuantizedMesh } from '@vibeglobe/core/decoders';
import { fixturePosition, type FixtureTile } from './generate.ts';
import { fixtureHeightMeters, terrainTile } from './terrain.ts';

// The peak's tile at level 8: the fixture's 4,000 m mountain, steep enough to show any decoding error.
const PEAK: FixtureTile = { pattern: 'world', scheme: 'mercator', level: 8, x: 132, y: 90 };

/** The analytic height at a point of the tile, `u` and `v` from 0 to 1 (v from the north). */
function expected(u: number, v: number): number {
  const { lonRad, latRad } = fixturePosition(PEAK, u, v);
  return fixtureHeightMeters(lonRad, latRad);
}

describe('fixture terrain', () => {
  for (const [encoding, resolutionMeters] of [
    ['terrarium', 1 / 256],
    ['terrain-rgb', 0.1],
  ] as const) {
    for (const sizePx of [256, 512]) {
      it(`serves ${encoding} tiles of ${sizePx} px that decode to the analytic heights (F129, F130)`, () => {
        const png = PNG.sync.read(terrainTile(PEAK, encoding, sizePx));
        const heights = decodeHeightmap(new Uint8Array(png.data), sizePx, encoding);
        let worst = 0;
        for (let y = 0; y < sizePx; y += 7)
          for (let x = 0; x < sizePx; x += 7)
            worst = Math.max(
              worst,
              Math.abs((heights[y * sizePx + x] ?? 0) - expected((x + 0.5) / sizePx, (y + 0.5) / sizePx)),
            );
        // Float32 storage adds at most 2^-9 m at heights below 4,096 m.
        expect(worst).toBeLessThanOrEqual(resolutionMeters / 2 + 2 ** -9);
      });
    }
  }

  it('serves quantized-mesh tiles whose grid vertices carry the analytic heights (F127)', () => {
    const mesh = decodeQuantizedMesh(new Uint8Array(terrainTile(PEAK, 'quantized-mesh', 256, 32)));
    const quantumMeters = (mesh.maxHeightMeters - mesh.minHeightMeters) / 32767;
    // Each vertex against the grid point it was encoded from: the height quantization, plus float32 header rounding.
    const gridPoint = (q: number): number => Math.round(q * 32) / 32;
    for (let i = 0; i < mesh.u.length; i += 37) {
      const errorMeters =
        (mesh.heightsMeters[i] ?? 0) - expected(gridPoint(mesh.u[i] ?? 0), 1 - gridPoint(mesh.v[i] ?? 0));
      expect(Math.abs(errorMeters)).toBeLessThanOrEqual(quantumMeters / 2 + 0.001);
    }
    expect(rasterizeQuantizedMesh(mesh, 32).heightsMeters.length).toBe(33 * 33);
    expect(mesh.west.length).toBe(33);
  });
});
