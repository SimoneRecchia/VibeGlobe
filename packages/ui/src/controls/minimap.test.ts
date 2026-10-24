import type { CameraState, GeoPosition } from '@vibeglobe/core';
import { geodesicInverse } from '@vibeglobe/core/geodesy';
import { describe, expect, it } from 'vitest';
import { footprintOutline, unwrapOutline } from './minimap.js';

const camera = (longitudeDeg: number, latitudeDeg: number, altitudeMeters: number): CameraState =>
  ({ eyeLongitudeDeg: longitudeDeg, eyeLatitudeDeg: latitudeDeg, altitudeMeters }) as unknown as CameraState;
const at = (longitudeDeg: number, latitudeDeg: number): GeoPosition => ({ longitudeDeg, latitudeDeg });

describe('the minimap footprint (F417, KB-169)', () => {
  it('closes the sky of a tilted view with the horizon in front, never behind the eye', () => {
    const eye = camera(10, 45, 2000);
    // Looking north: the top edge shows sky, the sides and the bottom ground.
    const samples = [
      undefined,
      undefined,
      at(10.3, 45.4),
      at(10.2, 45.1),
      at(9.9, 45.02),
      at(9.8, 45.1),
      at(9.7, 45.4),
      undefined,
    ];
    const outline = footprintOutline(eye, samples);
    expect(outline.length).toBeGreaterThan(5);
    for (const point of outline) {
      const azimuth = geodesicInverse(10, 45, point.longitudeDeg, point.latitudeDeg).initialAzimuthDeg;
      // Nothing more than 90° off the view direction (north) except the near bottom edge's points.
      if (point.latitudeDeg > 45.05) expect(Math.abs(azimuth)).toBeLessThan(90);
    }
  });

  it('draws the whole horizon when no edge shows ground', () => {
    expect(footprintOutline(camera(0, 0, 1e7), [undefined, undefined]).length).toBeGreaterThan(40);
  });

  it('finds the pole a footprint goes around, and unwraps one across the antimeridian', () => {
    const around = footprintOutline(camera(10, 70, 5e6), [undefined]);
    expect(unwrapOutline(around).pole).toBe(1);
    const across = unwrapOutline([at(179, 10), at(-179, 10), at(-179, 12), at(179, 12)]);
    expect(across.pole).toBe(0);
    expect(across.longitudesDeg).toEqual([179, 181, 181, 179]);
  });
});
