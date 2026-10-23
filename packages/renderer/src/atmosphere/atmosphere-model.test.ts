import { describe, expect, it } from 'vitest';
import { geodeticToEcef, MorphFrame, type FrameView } from '@vibeglobe/core';
import {
  Atmosphere,
  createAtmosphereFrame,
  ecefVisibility,
  globeFrame,
  morphFrame,
  type AtmosphereFrame,
  type AtmosphereOptions,
} from './atmosphere.js';
import {
  ATMOSPHERE,
  ATMOSPHERE_QUALITY,
  surfaceVisibility,
  type AtmosphereQuality,
  type LocalRay,
} from './atmosphere-model.js';
import { altitudeAlong, distanceToAltitude, lightDepth, skyRadiance } from './atmosphere-model.js';

const R = ATMOSPHERE.radiusKm;

/** The optical depth to space by brute-force integration in 50 m steps, in the units of `lightDepth`. */
function integratedDepth(h: number, mu: number, scaleKm: number): number {
  let depth = 0;
  for (let d = 0.025; ; d += 0.05) {
    const altitude = altitudeAlong(h, R, mu, d);
    if (altitude < 0) return Number.POSITIVE_INFINITY;
    if (altitude > h + 30 * scaleKm) return depth / scaleKm;
    depth += Math.exp(-altitude / scaleKm) * 0.05;
  }
}

describe('atmosphere model', () => {
  it('computes altitudes along a ray without cancellation, for any radius', () => {
    // A horizontal ray 100 km long rises by about d² / 2R.
    expect(altitudeAlong(0, R, 0, 100)).toBeCloseTo(100 ** 2 / (2 * R), 3);
    // On a nearly flat sphere the same ray stays at the eye's height, and a slanted one rises by d·mu.
    expect(altitudeAlong(2, R * 1e6, 0, 100)).toBeCloseTo(2, 5);
    expect(altitudeAlong(2, R * 1e6, 0.1, 100)).toBeCloseTo(12, 4);
    expect(distanceToAltitude(10, R, -1, 0, false)).toBeCloseTo(10, 9);
    expect(distanceToAltitude(10, R, 1, ATMOSPHERE.topKm, true)).toBeCloseTo(70, 9);
    expect(distanceToAltitude(10, R, 1, 0, false)).toBeLessThan(0);
  });

  it('matches the integrated optical depth toward the Sun within 6% at every angle above the ground', () => {
    for (const scaleKm of [ATMOSPHERE.rayleighScaleHeightKm, ATMOSPHERE.mieScaleHeightKm]) {
      for (const h of [0.5, 2, 10, 40]) {
        for (const mu of [1, 0.5, 0.2, 0.05, 0, -0.02, -0.05, -0.1]) {
          const expected = integratedDepth(h, mu, scaleKm);
          const actual = lightDepth(h, R, mu, scaleKm);
          if (!Number.isFinite(expected)) {
            expect(actual).toBe(Number.POSITIVE_INFINITY);
            continue;
          }
          expect(Math.abs(actual / expected - 1), `H ${scaleKm}, h ${h}, mu ${mu}`).toBeLessThan(0.06);
        }
      }
    }
  });

  it('colors the day sky blue overhead and the sunset red toward the Sun', () => {
    const s = Math.SQRT1_2;
    const zenith = skyRadiance({ up: [0, 0, 1], view: [0, 0, 1], sun: [s, 0, s] }, 0, R).radiance;
    expect(zenith[2]).toBeGreaterThan(zenith[1]);
    expect(zenith[1]).toBeGreaterThan(zenith[0]);
    const sunset = skyRadiance({ up: [0, 0, 1], view: [1, 0, 0.02], sun: [1, 0, 0.01] }, 0, R).radiance;
    expect(sunset[0]).toBeGreaterThan(sunset[2] * 5);
  });

  it('changes the glow continuously with altitude, across the top of the atmosphere (F392)', () => {
    // The limb seen from each altitude: a ray grazing 20 km above the ground, the Sun behind the eye.
    let previous: number | undefined;
    for (let h = 1; h <= 400; h *= 1.05) {
      const grazing = -Math.sqrt(1 - ((R + 20) / (R + h)) ** 2);
      const mu = h > 20 ? grazing : 0.05;
      const view: [number, number, number] = [Math.sqrt(1 - mu * mu), 0, mu];
      const glow = skyRadiance({ up: [0, 0, 1], view, sun: [0, 0, 1] }, h, R).radiance[2];
      if (previous !== undefined && h > 25) expect(Math.abs(glow - previous)).toBeLessThan(0.08 * previous + 0.01);
      previous = glow;
    }
  });

  it('hides distant ground near the horizon and keeps near ground clear (F394, F395)', () => {
    const nearGround = surfaceVisibility({ eyeAltitudeKm: 0.3, radiusKm: R, viewMu: -0.1, maxDistanceKm: 3 });
    // Ground 200 km away, near the horizon seen from a tilted view 300 m up.
    const ray: LocalRay = { eyeAltitudeKm: 0.3, radiusKm: R, viewMu: -0.0098, maxDistanceKm: 200 };
    const horizon = surfaceVisibility(ray);
    const fromOrbit = surfaceVisibility({ eyeAltitudeKm: 20_000, radiusKm: R, viewMu: -1, maxDistanceKm: 20_000 });
    expect(nearGround).toBeGreaterThan(0.95);
    expect(horizon).toBeLessThan(0.1);
    expect(fromOrbit).toBeGreaterThan(0.7);
    // The engine's form, between ECEF points: 150 km north along the ground from 300 m up is mostly hidden.
    const eye = geodeticToEcef(0.1, 0.8, 300, new Float64Array(3));
    expect(ecefVisibility(eye, geodeticToEcef(0.1, 0.8, 0, new Float64Array(3)))).toBeGreaterThan(0.99);
    expect(ecefVisibility(eye, geodeticToEcef(0.1, 0.8 + 150 / 6371, 0, new Float64Array(3)))).toBeLessThan(0.15);
    // More haze hides more.
    expect(surfaceVisibility({ eyeAltitudeKm: 0.3, radiusKm: R, viewMu: -0.05, maxDistanceKm: 6 }, 4)).toBeLessThan(
      surfaceVisibility({ eyeAltitudeKm: 0.3, radiusKm: R, viewMu: -0.05, maxDistanceKm: 6 }, 1),
    );
  });

  it('spends more samples at higher quality', () => {
    const order: AtmosphereQuality[] = [
      ATMOSPHERE_QUALITY.low,
      ATMOSPHERE_QUALITY.medium,
      ATMOSPHERE_QUALITY.high,
      ATMOSPHERE_QUALITY.ultra,
    ];
    for (let i = 1; i < order.length; i++) {
      expect(order[i]?.skySamples).toBeGreaterThan(order[i - 1]?.skySamples ?? 0);
      expect(order[i]?.surfaceSamples).toBeGreaterThan(order[i - 1]?.surfaceSamples ?? 0);
    }
  });
});

describe('atmosphere frame', () => {
  it('measures the eye above the ellipsoid on the polar-scaled sphere', () => {
    const frame: AtmosphereFrame = createAtmosphereFrame();
    for (const latitudeDeg of [0, 45, 89.9]) {
      const eye = geodeticToEcef(0.3, (latitudeDeg * Math.PI) / 180, 1000, new Float64Array(3));
      globeFrame(eye, frame);
      // Heights grow by at most the polar scale (0.34%): the sphere is the ellipsoid stretched along the polar axis.
      expect(frame.eyeAltitudeM / 1000).toBeGreaterThan(0.9999);
      expect(frame.eyeAltitudeM / 1000).toBeLessThan(ATMOSPHERE.polarScale + 1e-6);
      expect(Math.hypot(frame.up[0] ?? 0, frame.up[1] ?? 0, frame.up[2] ?? 0)).toBeCloseTo(1, 12);
    }
  });

  it('blends the curvature away continuously as the view morphs flat (F393)', () => {
    const frame = createAtmosphereFrame();
    const up = [0, 0, 1];
    let previousDip: number | undefined;
    for (let i = 0; i <= 100; i++) {
      morphFrame(i / 100, 10_000, up, frame);
      // The horizon's dip below the eye's horizontal: smooth in the morph parameter, with no step at either end.
      const dip = Math.sqrt((2 * frame.eyeAltitudeM) / frame.radiusM);
      if (previousDip !== undefined) expect(Math.abs(dip - previousDip)).toBeLessThan(0.002);
      previousDip = dip;
    }
    expect(morphFrame(0, 10_000, up, frame).radiusM).toBe(R * 1000);
    expect(frame.axisScale[2]).toBe(ATMOSPHERE.polarScale);
    expect(morphFrame(1, 10_000, up, frame).axisScale[2]).toBe(1);
  });
});

describe('Atmosphere', () => {
  const view: FrameView = {
    morph: new MorphFrame(),
    // Looking down the −z axis of the world with x to the right: the identity rotation.
    view: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    projection: new Float64Array([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, -1, 0, 0, 0.1, 0]),
    eyeEcef: new Float64Array([0, 0, (6_356_752.314245 + 2_000_000) * 1]),
    widthPx: 300,
    heightPx: 200,
    pixelRatio: 1,
  };
  type Uniforms = Record<string, { value: { x: number; y: number; z: number } | number }>;
  const uniformsOf = (atmosphere: Atmosphere): Uniforms => (atmosphere as unknown as { uniforms: Uniforms }).uniforms;

  it('puts the Sun behind the eye unless sun lighting is on, and follows the time without a rebuild (F396)', () => {
    const atmosphere = new Atmosphere('reversed-z');
    atmosphere.update(view);
    const u = uniformsOf(atmosphere);
    expect(u['sun']?.value).toEqual(u['up']?.value);
    expect(u['eyeAltitudeKm']?.value).toBeCloseTo(2000 * ATMOSPHERE.polarScale, 3);
    const material = atmosphere.sky.material;
    const lit: Partial<AtmosphereOptions> = { sunLighting: true, timeMs: Date.parse('2024-06-20T20:51:00Z') };
    atmosphere.setOptions(lit);
    atmosphere.update(view);
    const sun = u['sun']?.value as { x: number; y: number; z: number };
    // The June solstice: the Sun 23.44° north, scaled by the polar axis like every normal.
    expect(Math.asin(sun.z / Math.hypot(sun.x, sun.y, sun.z)) / (Math.PI / 180)).toBeCloseTo(23.5, 0);
    expect(u['lighting']?.value).toBe(1);
    expect(atmosphere.sky.material).toBe(material);
    atmosphere.dispose();
  });

  it('derives the sky rays from the projection: the center ray and one unit of x and y in device coordinates', () => {
    const atmosphere = new Atmosphere('fragment');
    atmosphere.update(view);
    const u = uniformsOf(atmosphere);
    expect(u['rayCenter']?.value).toMatchObject({ x: 0, y: 0, z: -1 });
    expect(u['rayX']?.value).toMatchObject({ x: 0.5, y: 0, z: 0 });
    expect((u['rayY']?.value as { y: number }).y).toBeCloseTo(1 / 3, 12);
    atmosphere.setOptions({ quality: ATMOSPHERE_QUALITY.low });
    expect(u['skySamples']?.value).toBe(ATMOSPHERE_QUALITY.low.skySamples);
    atmosphere.dispose();
  });
});
