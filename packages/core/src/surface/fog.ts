// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Fog-aware detail (F395, ADR 0040): the fraction of light from a surface point that reaches the eye through the
 * atmosphere's haze. The selection multiplies a tile's errors by it, so fully hazed tiles near the horizon are not
 * requested at fine levels. The renderer's atmosphere model uses the same functions. Numbers cross calls in arrays
 * (ADR 0018): the selection calls {@link fogVisibilityInto} for every tile it visits.
 */

/** The sphere the atmosphere sits on (the WGS84 semi-major axis, km) and the polar scale a / b that makes it one. */
const RADIUS_KM = 6378.137;
const POLAR_SCALE = 6378.137 / 6356.752314245;
/** Where the density is negligible (Rayleigh e^−10), km. */
const TOP_KM = 80;
const RAYLEIGH_SCALE_KM = 8;
const MIE_SCALE_KM = 1.2;
/** Rayleigh extinction at sea level for red, green and blue (680, 550, 440 nm), and Mie's, per km. */
const RAYLEIGH_R = 5.802e-3;
const RAYLEIGH_G = 13.558e-3;
const RAYLEIGH_B = 33.1e-3;
const MIE_EXTINCTION = 4.44e-3;

/**
 * The visibility of the ray in `io`: reads the eye's altitude (km), the sphere's radius (km), the ray's zenith cosine,
 * its length to the surface (km), the haze and the sample count from `io[0..5]`, and writes the visibility, weighted
 * like luminance (most from green), to `io[6]`.
 */
function marchInto(io: Float64Array): void {
  const h0 = Math.max(0, io[0] ?? 0);
  const r = io[1] ?? RADIUS_KM;
  const mu = io[2] ?? 0;
  const samples = io[5] ?? 8;
  // Where the ray leaves the atmosphere: the far root of |eye + d·dir| = r + top, written out (doubles passed to a
  // call the compiler does not inline are boxed, KB-133).
  const r0 = r + h0;
  const b0 = r0 * mu;
  const disc = (TOP_KM - h0) * (2 * r + TOP_KM + h0) + b0 * b0;
  let exit = 0;
  if (disc >= 0) {
    const q = -(b0 + (b0 >= 0 ? 1 : -1) * Math.sqrt(disc));
    const other = q === 0 ? 0 : ((h0 - TOP_KM) * (2 * r + h0 + TOP_KM)) / q;
    exit = q > other ? q : other;
  }
  const length = io[3] ?? 0;
  const end = exit < 0 ? 0 : length < exit ? length : exit;
  let rayleigh = 0;
  let mie = 0;
  // Samples crowd toward the eye (t²), where the air is densest for views near the ground.
  for (let i = 0; i < samples; i++) {
    const a = i / samples;
    const b = (i + 1) / samples;
    const d = end * ((a + b) / 2) * ((a + b) / 2);
    const step = end * (b * b - a * a);
    // The altitude at distance d: h0 + (r_d² − r0²) / (r_d + r0), with no cancellation for any radius.
    const grow = d * (2 * r0 * mu + d);
    const along = h0 + grow / (Math.sqrt(r0 * r0 + grow) + r0);
    const h = along > 0 ? along : 0;
    rayleigh += Math.exp(-h / RAYLEIGH_SCALE_KM) * step;
    mie += Math.exp(-h / MIE_SCALE_KM) * step;
  }
  const mieDepth = MIE_EXTINCTION * (io[4] ?? 1) * mie;
  io[6] =
    0.2126 * Math.exp(-(RAYLEIGH_R * rayleigh + mieDepth)) +
    0.7152 * Math.exp(-(RAYLEIGH_G * rayleigh + mieDepth)) +
    0.0722 * Math.exp(-(RAYLEIGH_B * rayleigh + mieDepth));
}

const ray = new Float64Array(7);

/** One view ray in the local frame of the eye, for {@link surfaceVisibility}. */
export interface FogRay {
  /** The eye's altitude above the sphere, km (slightly negative values are clamped). */
  readonly eyeAltitudeKm: number;
  /** The sphere's radius, km: the globe's, growing toward infinity as the view morphs flat. */
  readonly radiusKm: number;
  /** Cosine of the view ray's angle from the eye's zenith. */
  readonly viewMu: number;
  /** The ray's length to the surface, km. */
  readonly maxDistanceKm: number;
}

/**
 * The fraction of light from a surface at the end of a ray that reaches the eye: 1 in clear air, toward 0 where the
 * haze (aerosol density relative to a clear day) hides the surface.
 */
export function surfaceVisibility(fogRay: FogRay, haze = 1, samples = 8): number {
  ray[0] = fogRay.eyeAltitudeKm;
  ray[1] = fogRay.radiusKm;
  ray[2] = fogRay.viewMu;
  ray[3] = fogRay.maxDistanceKm;
  ray[4] = haze;
  ray[5] = samples;
  marchInto(ray);
  return ray[6] ?? 1;
}

/**
 * The visibility of a point seen from an eye on the globe, both ECEF meters, the point given relative to the eye in
 * `offset` and the distance to use in `io[0]` (meters), the haze in `io[1]`; writes the visibility to `io[2]`. The polar
 * axis scaled by a / b turns the ellipsoid into the atmosphere's sphere (ADR 0040). Allocates nothing.
 */
export function fogVisibilityInto(eye: Float64Array, offset: Float64Array, io: Float64Array): void {
  const ex = eye[0] ?? 0;
  const ey = eye[1] ?? 0;
  const ez = (eye[2] ?? 0) * POLAR_SCALE;
  const eyeDistance = Math.sqrt(ex * ex + ey * ey + ez * ez) || 1;
  const dx = offset[0] ?? 0;
  const dy = offset[1] ?? 0;
  const dz = (offset[2] ?? 0) * POLAR_SCALE;
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (length === 0) {
    io[2] = 1;
    return;
  }
  ray[0] = eyeDistance / 1000 - RADIUS_KM;
  ray[1] = RADIUS_KM;
  ray[2] = (dx * ex + dy * ey + dz * ez) / (length * eyeDistance);
  ray[3] = (io[0] ?? 0) / 1000;
  ray[4] = io[1] ?? 1;
  ray[5] = 8;
  marchInto(ray);
  io[2] = ray[6] ?? 1;
}
