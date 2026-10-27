// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Terrain collision (F146, F147, ADR 0028): how high the camera's target is raised along its normal so the eye keeps
 * its clearance above the terrain. Pure arithmetic, per frame; allocates nothing.
 */

/**
 * The target's lift for this frame, meters: enough for the eye (`unliftedMeters` high without any lift) to stay
 * `clearanceMeters` above `surfaceMeters`, the surface as the frame shows it under the eye, and above `finestMeters`,
 * the finest resident terrain there less the eye's shortfall ({@link shortfallMeters}). Never negative.
 */
export function liftMeters(
  unliftedMeters: number,
  surfaceMeters: number,
  finestMeters: number,
  clearanceMeters: number,
): number {
  const shown = surfaceMeters + clearanceMeters - unliftedMeters;
  const finest = finestMeters + clearanceMeters - unliftedMeters;
  const lift = shown > finest ? shown : finest;
  return lift > 0 ? lift : 0;
}

/**
 * How far below its clearance above the finest resident terrain the eye may be this frame, meters (F147, KB-219): a
 * finer level arriving under it opens a shortfall of how much higher it lies (`risenMeters`), and the shortfall closes
 * by a quarter a frame, so the eye rises over a few frames instead of jumping. It is the eye's, kept from frame to
 * frame: movements and inputs write the camera's target back each frame, which restarted a catch-up of the lift.
 */
export function shortfallMeters(previousMeters: number, risenMeters: number): number {
  const shortfall = 0.75 * previousMeters + (risenMeters > 0 ? risenMeters : 0);
  return shortfall < 0.5 ? 0 : shortfall;
}
