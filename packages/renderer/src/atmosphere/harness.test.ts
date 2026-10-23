import { describe, expect, it } from 'vitest';
import { Camera, geodeticToEcef } from '@vibeglobe/core';
import { createAtmosphereHarness, ellipsoidGeometry, projectPx, type AtmosphereHarness } from './harness.js';

describe('atmosphere harness', () => {
  it('builds the ellipsoid with imagery coordinates running north to south', () => {
    const geometry = ellipsoidGeometry();
    const uv = geometry.getAttribute('imageryUv');
    expect(geometry.getAttribute('position').count).toBe(513 * 257);
    // The first row is the North Pole, at the top of the image (v = 1 with three.js's flipped image rows).
    expect(uv.getY(0)).toBe(1);
    expect(uv.getY(uv.count - 1)).toBe(0);
    geometry.dispose();
  });

  it('projects the camera target to the viewport center and hides points behind the eye', () => {
    const camera = new Camera();
    camera.widthPx = 480;
    camera.heightPx = 320;
    camera.pose.targetLongitudeRad = 0.2;
    camera.pose.targetLatitudeRad = 0.7;
    camera.pose.rangeMeters = 50_000;
    camera.update();
    const center = projectPx(camera, geodeticToEcef(0.2, 0.7, 0, new Float64Array(3)));
    expect(center?.x).toBeCloseTo(240, 6);
    expect(center?.y).toBeCloseTo(160, 6);
    expect(projectPx(camera, geodeticToEcef(0.2, 0.7, 200_000, new Float64Array(3)))).toBeNull();
  });

  it('needs the page canvas', () => {
    const create: (document: Document) => AtmosphereHarness = createAtmosphereHarness;
    expect(() => create({ querySelector: () => null } as unknown as Document)).toThrow('no canvas');
  });
});
