// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
// How much of the space background shows (ADR 0181): all of it from space and at night, none under the atmosphere's
// daytime sky near the ground, faded in between, and none around a flat map seen from high above. Near the ground the
// flat map lies in the tangent plane at its anchor (ADR 0008), so the celestial frame still fits its horizon there.

const WGS84_A = 6_378_137;
const WGS84_B = 6_356_752.314245;

/** Below this altitude the daytime sky hides the stars entirely, meters. */
const DAY_SKY_TOP_M = 20_000;
/** Above this altitude the sky is space's black whatever the time, meters. */
const SPACE_ALTITUDE_M = 120_000;
/** The Sun's elevation above which the sky at the eye is day, sine (0°). */
const DAY_SIN = 0;
/** The Sun's elevation below which it is night, sine (−10°: deep nautical twilight). */
const NIGHT_SIN = -Math.sin((10 * Math.PI) / 180);

/** What the visibility depends on in a frame. */
export interface SkyConditions {
  readonly eyeEcef: ArrayLike<number>;
  /** The unit vector toward the Sun, ECEF; with sun lighting off the engine's sky is day everywhere. */
  readonly sunEcef: ArrayLike<number> | undefined;
  /** Whether the engine draws the atmosphere's sky (its quality level is not 'off'). */
  readonly atmosphere: boolean;
  /** The globe-to-flat morph, 0 on the globe. */
  readonly morph: number;
  /** Whether the atmosphere's daytime sky fades the background (default true); the flat map's fade always applies. */
  readonly fade?: boolean;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** The eye's height above the ellipsoid along the geocentric radius, meters (close enough for a fade). */
export function eyeAltitudeMeters(eyeEcef: ArrayLike<number>): number {
  const x = eyeEcef[0] ?? 0;
  const y = eyeEcef[1] ?? 0;
  const z = eyeEcef[2] ?? 0;
  const r = Math.hypot(x, y, z);
  if (r === 0) return 0;
  const cos = Math.hypot(x, y) / r;
  const sin = z / r;
  return r - (WGS84_A * WGS84_B) / Math.hypot(WGS84_B * cos, WGS84_A * sin);
}

/**
 * The opacity of the stars and the Milky Way, 0–1. Without the atmosphere's sky nothing covers them; with it they
 * show where the Sun stands below −10° at the eye or the eye is above 120 km, and fade out toward a daytime sky under
 * 20 km. With sun lighting off the engine's sky is lit everywhere, so near the ground they are hidden. A flat map seen
 * from above 20 km hides them as it morphs flat: a world map has no sky.
 */
export function skyVisibility(conditions: SkyConditions): number {
  const eye = conditions.eyeEcef;
  const space = smoothstep(DAY_SKY_TOP_M, SPACE_ALTITUDE_M, eyeAltitudeMeters(eye));
  const flat = 1 - Math.min(1, Math.max(0, conditions.morph)) * space;
  if (!conditions.atmosphere || conditions.fade === false) return flat;
  let night = 0;
  const sun = conditions.sunEcef;
  if (sun) {
    const r = Math.hypot(eye[0] ?? 0, eye[1] ?? 0, eye[2] ?? 0) || 1;
    const sinElevation =
      ((eye[0] ?? 0) * (sun[0] ?? 0) + (eye[1] ?? 0) * (sun[1] ?? 0) + (eye[2] ?? 0) * (sun[2] ?? 0)) / r;
    night = smoothstep(DAY_SIN, NIGHT_SIN, sinElevation);
  }
  return flat * Math.max(space, night);
}
