// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { WGS84 } from '../geodesy/wgs84.js';
import type { Camera } from './camera.js';

const E2 = WGS84.firstEccentricitySquared;
const A = WGS84.semiMajorAxisMeters;

/** Slots of an orbit's state, in one array (ADR 0018). */
const CENTER_LON = 0;
const CENTER_LAT = 1;
/** The target's offset from the center at the start, meters east and north. */
const EAST = 2;
const NORTH = 3;
const HEADING0 = 4;
const START_MS = 5;
const RATE = 6;
/** Meters per radian of longitude and of latitude at the center. */
const PER_LON = 7;
const PER_LAT = 8;

/**
 * A continuous orbit (F192): the camera turns about the vertical through a center point at a constant rate, its
 * heading turning with it, so the center keeps its place on screen and its distance to the eye stays the same. A
 * function of engine time alone (F203); it never ends by itself. Allocates nothing per frame.
 */
export class Orbit {
  readonly animatesTilt = false;
  private readonly v = new Float64Array(9);

  /** Orbits the camera about `center` (longitude and latitude, radians) at `rateRad` per second from `startMs`. */
  constructor(camera: Camera, center: Float64Array, rateRad: number, startMs: number) {
    const v = this.v;
    const lat = center[1] ?? 0;
    const w = Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
    v[CENTER_LON] = center[0] ?? 0;
    v[CENTER_LAT] = lat;
    v[PER_LON] = (A / w) * Math.cos(lat);
    v[PER_LAT] = (A * (1 - E2)) / (w * w * w);
    let dLon = camera.pose.targetLongitudeRad - (center[0] ?? 0);
    if (dLon > Math.PI) dLon -= 2 * Math.PI;
    else if (dLon < -Math.PI) dLon += 2 * Math.PI;
    v[EAST] = dLon * (v[PER_LON] ?? 1);
    v[NORTH] = (camera.pose.targetLatitudeRad - lat) * (v[PER_LAT] ?? 1);
    v[HEADING0] = camera.pose.headingRad;
    v[START_MS] = startMs;
    v[RATE] = rateRad;
  }

  /** Writes the pose at engine time `io[0]` (milliseconds); an orbit never completes on its own. */
  step(camera: Camera, io: Float64Array): boolean {
    const v = this.v;
    const angle = (((io[0] ?? 0) - (v[START_MS] ?? 0)) / 1000) * (v[RATE] ?? 0);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    // A clockwise turn seen from above (the heading's sense) of the target's offset about the center.
    const east = (v[EAST] ?? 0) * cos + (v[NORTH] ?? 0) * sin;
    const north = -(v[EAST] ?? 0) * sin + (v[NORTH] ?? 0) * cos;
    const pose = camera.pose;
    pose.targetLongitudeRad = (v[CENTER_LON] ?? 0) + east / (v[PER_LON] ?? 1);
    pose.targetLatitudeRad = (v[CENTER_LAT] ?? 0) + north / (v[PER_LAT] ?? 1);
    pose.headingRad = (v[HEADING0] ?? 0) + angle;
    io[1] = pose.tiltRad;
    return false;
  }
}
