/**
 * Terrain collision (F146, F147, ADR 0027): how high the camera's target is raised along its normal so the eye keeps
 * its clearance above the terrain. Pure arithmetic, per frame; allocates nothing.
 */

/**
 * The target's lift for this frame, meters: enough for the eye (`unliftedMeters` high without any lift) to stay
 * `clearanceMeters` above `surfaceMeters`, the surface as the frame shows it under the eye, which morphs smoothly as
 * finer terrain arrives (F147). When the finest resident terrain under the eye, `finestMeters`, lies higher than what is
 * shown, the lift catches up with it from `liftMeters` (last frame's) by a quarter of the gap per frame, at least half
 * a meter, so the eye neither jumps nor stays below it for more than a few frames (F146). Never negative.
 */
export function liftMeters(
  liftMeters: number,
  unliftedMeters: number,
  surfaceMeters: number,
  finestMeters: number,
  clearanceMeters: number,
): number {
  const shown = surfaceMeters + clearanceMeters - unliftedMeters;
  const finest = finestMeters + clearanceMeters - unliftedMeters;
  const next = shown > 0 ? shown : 0;
  if (finest <= next) return next;
  const from = liftMeters > next ? liftMeters : next;
  if (from >= finest) return finest;
  const step = (finest - from) / 4;
  const raised = from + (step > 0.5 ? step : 0.5);
  return raised < finest ? raised : finest;
}
