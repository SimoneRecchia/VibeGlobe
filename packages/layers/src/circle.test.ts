import { geodesicInverse } from '@vibeglobe/core/geodesy';
import { describe, expect, it } from 'vitest';
import { ellipseGeometry } from './circle.js';

describe('geodesic circles and ellipses (F356)', () => {
  it('places every outline point at the configured geodesic distance from the center, at any latitude', () => {
    for (const [lon, lat] of [
      [0, 0],
      [10, 60],
      [45, 89],
    ] as const) {
      const circle = ellipseGeometry([lon, lat], { radiusMeters: 250_000 });
      for (let i = 0; i * 3 < circle.positions.length; i++) {
        const { distanceMeters } = geodesicInverse(
          lon,
          lat,
          circle.positions[i * 3] ?? 0,
          circle.positions[i * 3 + 1] ?? 0,
        );
        expect(Math.abs(distanceMeters - 250_000) / 250_000).toBeLessThan(0.001);
      }
    }
  });

  it('gives an ellipse its two radii along its rotated axes', () => {
    const ellipse = ellipseGeometry([12.5, 41.9], {
      radiusMeters: 100_000,
      minorRadiusMeters: 40_000,
      rotationDeg: 30,
    });
    const distanceAt = (azimuthDeg: number): number => {
      let best = { error: Infinity, distance: 0 };
      for (let i = 0; i * 3 < ellipse.positions.length; i++) {
        const r = geodesicInverse(12.5, 41.9, ellipse.positions[i * 3] ?? 0, ellipse.positions[i * 3 + 1] ?? 0);
        const error = Math.abs(((r.initialAzimuthDeg - azimuthDeg + 540) % 360) - 180);
        if (error < best.error) best = { error, distance: r.distanceMeters };
      }
      return best.distance;
    };
    expect(distanceAt(30) / 100_000).toBeCloseTo(1, 3);
    expect(distanceAt(120) / 40_000).toBeCloseTo(1, 3);
    // A closed ring: the last point repeats the first.
    expect(ellipse.positions.at(-3)).toBeCloseTo(ellipse.positions[0] ?? NaN, 9);
  });
});
