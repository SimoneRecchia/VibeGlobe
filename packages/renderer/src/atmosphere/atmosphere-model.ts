// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { surfaceVisibility } from '@vibeglobe/core';
// The atmosphere model shared by the shaders (`atmosphere-nodes.ts`) and the CPU (fog-aware tile detail, tests):
// single scattering by air molecules (Rayleigh) and aerosols (Mie) in exponential layers over a sphere, integrated along
// the view ray, with the light path's optical depth from an analytic Chapman function (ADR 0040). Distances in
// kilometers. Every altitude along a ray is computed without subtracting the planet radius from a distance to the
// center, so the same formulas hold for a curvature radius growing without bound as the globe morphs flat (F393).

/** Physical constants of the atmosphere, per kilometer (Bruneton and Neyret 2008; Hillaire 2020). */
export const ATMOSPHERE = {
  /** The WGS84 semi-major axis: the sphere the atmosphere sits on, after scaling the polar axis (ADR 0040). */
  radiusKm: 6378.137,
  /** The polar axis scale that turns the WGS84 ellipsoid into that sphere: a / b. */
  polarScale: 6378.137 / 6356.752314245,
  /** Where the density is negligible (Rayleigh e^−10). */
  topKm: 80,
  rayleighScaleHeightKm: 8,
  /** Rayleigh scattering at sea level for red, green and blue (680, 550, 440 nm). */
  rayleighPerKm: [5.802e-3, 13.558e-3, 33.1e-3] as const,
  mieScaleHeightKm: 1.2,
  mieScatteringPerKm: 3.996e-3,
  mieExtinctionPerKm: 4.44e-3,
  /** Mie phase asymmetry. */
  mieG: 0.8,
} as const;

/** One view ray in the local frame of the eye: the planet below it and the ray's and the Sun's directions. */
export interface LocalRay {
  /** The eye's altitude above the sphere, km (≥ 0 in practice; slightly negative values are clamped). */
  readonly eyeAltitudeKm: number;
  /** The sphere's radius: {@link ATMOSPHERE}'s `radiusKm` on the globe, growing toward infinity as it morphs flat. */
  readonly radiusKm: number;
  /** Cosine of the view ray's angle from the eye's zenith. */
  readonly viewMu: number;
  /** The ray's length when it ends on a surface, km; Infinity for the sky. */
  readonly maxDistanceKm: number;
}

/** The surface visibility comes from core's fog-aware detail (F395), so the selection and this model agree. */
export { surfaceVisibility };

/**
 * The altitude at distance `d` along a ray leaving altitude `h0` at zenith cosine `mu`, over a sphere of radius `r`:
 * h0 + (r_d² − (r + h0)²) / (r_d + r + h0), with no cancellation for any radius.
 */
export function altitudeAlong(h0: number, r: number, mu: number, d: number): number {
  const r0 = r + h0;
  const grow = d * (2 * r0 * mu + d);
  const rd = Math.sqrt(r0 * r0 + grow);
  return h0 + grow / (rd + r0);
}

/**
 * The distance along a ray from altitude `h0` at zenith cosine `mu` to where it reaches altitude `target` over a sphere
 * of radius `r`: the far crossing when `far`, the near one otherwise; NaN when it never does. The discriminant is
 * written as (target − h0)(2r + target + h0) + r0²·mu², and the roots in the stable form, so neither cancels.
 */
export function distanceToAltitude(h0: number, r: number, mu: number, target: number, far: boolean): number {
  const r0 = r + h0;
  const b = r0 * mu;
  const disc = (target - h0) * (2 * r + target + h0) + b * b;
  if (disc < 0) return Number.NaN;
  const c = (h0 - target) * (2 * r + h0 + target);
  const q = -(b + (b >= 0 ? 1 : -1) * Math.sqrt(disc));
  const a = q;
  const other = q === 0 ? 0 : c / q;
  const near = Math.min(a, other);
  const farRoot = Math.max(a, other);
  return far ? farRoot : near;
}

/** The quality settings of the atmosphere (F399 maps the engine's presets onto these). */
export interface AtmosphereQuality {
  /** Samples along each sky ray. */
  readonly skySamples: number;
  /** Samples along each surface fragment's ray (haze and fog). */
  readonly surfaceSamples: number;
  /** Adds ±1 least-significant-bit noise to the output, which hides 8-bit banding (F392). */
  readonly dither: boolean;
}

/** The atmosphere's settings for the engine's quality presets; low suits tablets, ultra a desktop GPU. */
export const ATMOSPHERE_QUALITY: Readonly<Record<'low' | 'medium' | 'high' | 'ultra', AtmosphereQuality>> = {
  low: { skySamples: 8, surfaceSamples: 4, dither: true },
  medium: { skySamples: 12, surfaceSamples: 6, dither: true },
  high: { skySamples: 16, surfaceSamples: 8, dither: true },
  ultra: { skySamples: 24, surfaceSamples: 12, dither: true },
};

/**
 * The Chapman function Ch(x, mu) for x = (r + h) / H ≫ 1: the optical depth from a point toward the zenith cosine
 * `mu`, relative to the vertical one, through an exponential layer of scale height H. For mu ≥ 0 its large-x form
 * √(πx/2)·erfcx(√(x/2)·mu), with the bound erfcx(y) ≈ 2 / (√π (y + √(y² + 4/π))) (Abramowitz and Stegun 7.1.13);
 * below the horizontal the path through the tangent point minus the upward half beyond the start. Returns the optical
 * depth in units of H·density(h): `scaledDepth(h, ...)` multiplies in the density.
 */
function chapmanUp(x: number, mu: number): number {
  const y = Math.sqrt(x / 2) * mu;
  return (Math.sqrt((Math.PI * x) / 2) * 2) / (Math.sqrt(Math.PI) * (y + Math.sqrt(y * y + 4 / Math.PI)));
}

/**
 * The optical depth from altitude `h` toward zenith cosine `mu` to space, through an exponential layer of scale height
 * `scaleKm`, over a sphere of radius `r`, in units of (scale height × sea-level density). Infinite when the path
 * crosses the ground.
 */
export function lightDepth(h: number, r: number, mu: number, scaleKm: number): number {
  const x = (r + h) / scaleKm;
  if (mu >= 0) return Math.exp(-h / scaleKm) * chapmanUp(x, mu);
  // Below the horizontal: twice the horizontal depth at the tangent point, minus the upward path from the mirrored start.
  const sine = Math.sqrt(Math.max(0, 1 - mu * mu));
  const tangentAltitude = h * sine - (r * mu * mu) / (1 + sine);
  if (tangentAltitude < 0) return Number.POSITIVE_INFINITY;
  const x0 = (r + tangentAltitude) / scaleKm;
  return 2 * Math.exp(-tangentAltitude / scaleKm) * chapmanUp(x0, 0) - Math.exp(-h / scaleKm) * chapmanUp(x, -mu);
}

/** The extinction per km of each color channel at sea level: Rayleigh plus Mie. */
function extinction(channel: number, rayleighDensity: number, mieDensity: number, haze: number): number {
  return (ATMOSPHERE.rayleighPerKm[channel] ?? 0) * rayleighDensity + ATMOSPHERE.mieExtinctionPerKm * haze * mieDensity;
}

/** Up, view and Sun as unit vectors in any common frame, for {@link skyRadiance}. */
export interface SkyGeometry {
  readonly up: readonly [number, number, number];
  readonly view: readonly [number, number, number];
  readonly sun: readonly [number, number, number];
}

function dot3(a: readonly number[], b: readonly number[]): number {
  return (a[0] ?? 0) * (b[0] ?? 0) + (a[1] ?? 0) * (b[1] ?? 0) + (a[2] ?? 0) * (b[2] ?? 0);
}

/** The Rayleigh phase function, without its 3 / (16π) factor (folded into the sun intensity). */
function rayleighPhase(cosAngle: number): number {
  return 1 + cosAngle * cosAngle;
}

/** The Cornette-Shanks Mie phase function, relative like {@link rayleighPhase}. */
function miePhase(cosAngle: number, g = ATMOSPHERE.mieG): number {
  const g2 = g * g;
  return ((1.5 * (1 - g2)) / (2 + g2)) * ((1 + cosAngle * cosAngle) / (1 + g2 - 2 * g * cosAngle) ** 1.5);
}

/**
 * The light scattered toward the eye along a ray (red, green, blue, before exposure) and the ray's transmittance, the
 * CPU twin of the sky and haze shaders: tests compare its behavior across altitudes, and the shaders follow its steps.
 */
export function skyRadiance(
  geometry: SkyGeometry,
  eyeAltitudeKm: number,
  radiusKm: number,
  maxDistanceKm = Number.POSITIVE_INFINITY,
  samples = 16,
  haze = 1,
): { radiance: [number, number, number]; transmittance: [number, number, number] } {
  const h0 = Math.max(0, eyeAltitudeKm);
  const mu = dot3(geometry.view, geometry.up);
  const radiance = [0, 0, 0];
  const depth = [0, 0, 0];
  const exit = distanceToAltitude(h0, radiusKm, mu, ATMOSPHERE.topKm, true);
  // Above the top a ray first enters; below it starts at the eye.
  const enter = h0 > ATMOSPHERE.topKm ? distanceToAltitude(h0, radiusKm, mu, ATMOSPHERE.topKm, false) : 0;
  const ground = distanceToAltitude(h0, radiusKm, mu, 0, false);
  let end = Math.min(maxDistanceKm, Number.isNaN(exit) ? 0 : exit);
  if (!Number.isNaN(ground) && ground > 0) end = Math.min(end, ground);
  const start = Number.isNaN(enter) ? end : Math.max(0, enter);
  const cosAngle = dot3(geometry.view, geometry.sun);
  const rayleighP = rayleighPhase(cosAngle);
  const mieP = miePhase(cosAngle);
  const r0 = radiusKm + h0;
  for (let i = 0; i < samples && end > start; i++) {
    const a = i / samples;
    const b = (i + 1) / samples;
    const d = start + (end - start) * ((a + b) / 2) ** 2;
    const step = (end - start) * (b * b - a * a);
    const h = Math.max(0, altitudeAlong(h0, radiusKm, mu, d));
    const rayleighDensity = Math.exp(-h / ATMOSPHERE.rayleighScaleHeightKm) * step;
    const mieDensity = Math.exp(-h / ATMOSPHERE.mieScaleHeightKm) * step;
    // The sample's zenith: (r0·up + d·view) / |…|.
    const px = r0 * geometry.up[0] + d * geometry.view[0];
    const py = r0 * geometry.up[1] + d * geometry.view[1];
    const pz = r0 * geometry.up[2] + d * geometry.view[2];
    const sunMu = dot3([px, py, pz], geometry.sun) / Math.hypot(px, py, pz);
    const lightRayleigh = lightDepth(h, radiusKm, sunMu, ATMOSPHERE.rayleighScaleHeightKm);
    const lightMie = lightDepth(h, radiusKm, sunMu, ATMOSPHERE.mieScaleHeightKm);
    for (let c = 0; c < 3; c++) {
      const midDepth = (depth[c] ?? 0) + extinction(c, rayleighDensity, mieDensity, haze) / 2;
      const toSun =
        (ATMOSPHERE.rayleighPerKm[c] ?? 0) * ATMOSPHERE.rayleighScaleHeightKm * lightRayleigh +
        ATMOSPHERE.mieExtinctionPerKm * haze * ATMOSPHERE.mieScaleHeightKm * lightMie;
      const light = Math.exp(-midDepth - toSun);
      radiance[c] =
        (radiance[c] ?? 0) +
        light *
          ((ATMOSPHERE.rayleighPerKm[c] ?? 0) * rayleighDensity * rayleighP +
            ATMOSPHERE.mieScatteringPerKm * haze * mieDensity * mieP);
      depth[c] = (depth[c] ?? 0) + extinction(c, rayleighDensity, mieDensity, haze);
    }
  }
  return {
    radiance: [radiance[0] ?? 0, radiance[1] ?? 0, radiance[2] ?? 0],
    transmittance: [Math.exp(-(depth[0] ?? 0)), Math.exp(-(depth[1] ?? 0)), Math.exp(-(depth[2] ?? 0))],
  };
}

/**
 * Day and night (F647): the cosine of the Sun's zenith angle over which the day fades into the night, either side of
 * the terminator; ±0.12 makes a soft band about 14° wide, as map applications draw it.
 */
export const TERMINATOR_HALF_WIDTH = 0.12;

/** The night side's color factors (linear RGB): the imagery dimmed and tinted toward a deep blue. */
export const NIGHT_SHADE: readonly [number, number, number] = [0.06, 0.07, 0.14];

/** How much of the day reaches a point whose Sun is at zenith cosine `sunMu`: 1 by day, 0 by night, smooth between. */
export function daylight(sunMu: number): number {
  const t = Math.min(1, Math.max(0, (sunMu + TERMINATOR_HALF_WIDTH) / (2 * TERMINATOR_HALF_WIDTH)));
  return t * t * (3 - 2 * t);
}
