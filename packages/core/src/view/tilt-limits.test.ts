import { describe, expect, it } from 'vitest';
import { WGS84 } from '../geodesy/wgs84.js';
import { skyTiltLimitRad } from './tilt-limits.js';

const A = WGS84.semiMajorAxisMeters;
const FOV_RAD = 0.6435;
/** The angle above the screen center of the line a third of the way down: the sky limit's horizon (F166). */
const TOP_THIRD_RAD = Math.atan(Math.tan(FOV_RAD / 2) / 3);

/** How far above the screen center the horizon shows, from the eye, target and view ray in the plane (on the globe). */
function horizonAboveCenterRad(rangeMeters: number, tiltRad: number): number {
  const target = [0, A];
  const eye = [rangeMeters * Math.sin(tiltRad), A + rangeMeters * Math.cos(tiltRad)];
  const distance = Math.hypot(eye[0] ?? 0, eye[1] ?? 0);
  const nadir = [-(eye[0] ?? 0) / distance, -(eye[1] ?? 0) / distance];
  const view = [((target[0] ?? 0) - (eye[0] ?? 0)) / rangeMeters, ((target[1] ?? 0) - (eye[1] ?? 0)) / rangeMeters];
  const fromNadir = Math.acos((nadir[0] ?? 0) * (view[0] ?? 0) + (nadir[1] ?? 0) * (view[1] ?? 0));
  return Math.PI / 2 - Math.acos(A / distance) - fromNadir;
}

function skyLimitRad(rangeMeters: number): number {
  const values = new Float64Array(8);
  values.set([rangeMeters, 0, FOV_RAD, 0]);
  skyTiltLimitRad(values);
  return values[6] ?? 0;
}

describe('the empty-sky tilt limit (F166)', () => {
  it('puts the horizon on the line a third of the way down on the globe, no lower (KB-108)', () => {
    for (const rangeMeters of [3e5, 1e6, 3e6, 1e7]) {
      const limit = skyLimitRad(rangeMeters);
      expect(limit, `${rangeMeters} m`).toBeGreaterThan(0);
      expect(horizonAboveCenterRad(rangeMeters, limit), `${rangeMeters} m`).toBeCloseTo(TOP_THIRD_RAD, 6);
    }
    // A chosen 60° stands at 1,000 km: the horizon is still above the line there.
    expect(skyLimitRad(1e6)).toBeGreaterThan((60 * Math.PI) / 180);
  });
});
