import { WGS84 } from '../geodesy/wgs84.js';

const A = WGS84.semiMajorAxisMeters;
const HALF_PI = 1.5707963267948966;
/** The steepest tilt a view may have (the API's limit), radians. */
const MAX_TILT_RAD = (89 * Math.PI) / 180;
/** Bisection steps: 30 halvings of 89° leave less than 2e-9 radians. */
const STEPS = 30;

/**
 * Inputs and outputs of the tilt limits (ADR 0034), in one array so no double crosses a call (ADR 0018): the camera's
 * range, its target's height, its vertical field of view, the morph factor, the height of the surface under the eye
 * and the clearance; then the two limits the functions write.
 */
const RANGE = 0;
const TARGET_HEIGHT = 1;
const FOV = 2;
const MORPH = 3;
const GROUND = 4;
const CLEARANCE = 5;
/** Output of {@link skyTiltLimitRad}. */
const SKY_LIMIT = 6;
/** Output of {@link terrainTiltLimitRad}. */
const TERRAIN_LIMIT = 7;

/** The tilt being measured and the measure (horizon height or eye clearance), beside the inputs. */
const TILT = 8;
const MEASURE = 9;
const LOW = 10;
const HIGH = 11;
const io = new Float64Array(12);

/**
 * Writes to `io[MEASURE]` how far above the screen center the horizon shows at tilt `io[TILT]` (with `sky`), radians,
 * or else the eye's height above the surface under it, meters. On the globe the eye sits at distance d from the
 * Earth's center (a sphere of radius a), its local vertical turned by γ from the target's, and the horizon dips by
 * δ = acos(a / d); on the flat map the horizon is the plane's own, 90° − t above the center, and the eye is R·cos t
 * above the target. The morph mixes both.
 */
function measure(sky: boolean): void {
  const t = io[TILT] ?? 0;
  const range = io[RANGE] ?? 0;
  const targetHeight = io[TARGET_HEIGHT] ?? 0;
  const radius = A + targetHeight;
  const m = io[MORPH] ?? 0;
  const cos = Math.cos(t);
  const distance = Math.sqrt(radius * radius + range * range + 2 * radius * range * cos);
  if (sky) {
    const turn = Math.asin((range * Math.sin(t)) / distance);
    const ratio = A / distance;
    const dip = Math.acos(ratio < 1 ? ratio : 1);
    io[MEASURE] = (1 - m) * (HALF_PI - t - turn - dip) + m * (HALF_PI - t);
  } else io[MEASURE] = (1 - m) * (distance - A) + m * (range * cos + targetHeight) - (io[GROUND] ?? 0);
}

/**
 * The steepest tilt at which empty sky covers at most the top third of the screen (F166): the horizon at or above the
 * line a third of the way down. Reads `values[0..3]` and writes the limit to `values[6]`.
 */
export function skyTiltLimitRad(values: Float64Array): void {
  for (let i = 0; i < 6; i++) io[i] = values[i] ?? 0;
  io[CLEARANCE] = Math.atan(Math.tan((io[FOV] ?? 0) / 2) / 3);
  steepestWhere(true);
  values[SKY_LIMIT] = io[TILT] ?? 0;
}

/**
 * The steepest tilt that keeps the eye the clearance above the surface under it (F165). Reads `values[0..5]` and
 * writes the limit to `values[7]`.
 */
export function terrainTiltLimitRad(values: Float64Array): void {
  for (let i = 0; i < 6; i++) io[i] = values[i] ?? 0;
  steepestWhere(false);
  values[TERRAIN_LIMIT] = io[TILT] ?? 0;
}

/**
 * The largest tilt in [0°, 89°] whose measure is at least `io[CLEARANCE]` (the minimum), into `io[TILT]`: both measures
 * fall as the tilt rises, so a bisection finds it; 0 when even a vertical view falls short.
 */
function steepestWhere(sky: boolean): void {
  const minimum = io[CLEARANCE] ?? 0;
  io[TILT] = MAX_TILT_RAD;
  measure(sky);
  if ((io[MEASURE] ?? 0) >= minimum) return;
  io[TILT] = 0;
  measure(sky);
  if ((io[MEASURE] ?? 0) < minimum) return;
  // The bracket lives in the array: a double merged from a constant and a computed value may be boxed (ADR 0018).
  io[LOW] = 0;
  io[HIGH] = MAX_TILT_RAD;
  for (let step = 0; step < STEPS; step++) {
    io[TILT] = ((io[LOW] ?? 0) + (io[HIGH] ?? 0)) / 2;
    measure(sky);
    if ((io[MEASURE] ?? 0) >= minimum) io[LOW] = io[TILT] ?? 0;
    else io[HIGH] = io[TILT] ?? 0;
  }
  io[TILT] = io[LOW] ?? 0;
}
