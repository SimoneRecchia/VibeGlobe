/**
 * Local east-north-up (ENU) frames on the WGS84 ellipsoid and the aerospace heading/pitch/roll convention.
 *
 * A 3×3 rotation is stored column-major in 9 numbers (columns at indices 0–2, 3–5 and 6–8), the layout GPU APIs use.
 * The ENU frame written by {@link enuFrame} is therefore also the ENU → ECEF rotation.
 *
 * Orientations map body axes (x right, y forward, z up) to ECEF: their columns are the body's right, forward and up
 * unit vectors in ECEF. Heading turns clockwise from north (seen from above), pitch raises the nose (positive up) and
 * roll lowers the right wing (positive right-wing-down); they apply in that order (heading, then pitch, then roll),
 * the aerospace yaw-pitch-roll sequence, so heading = pitch = roll = 0 gives exactly the ENU frame.
 */

const HALF_PI = Math.PI / 2;
const TWO_PI = 2 * Math.PI;

/**
 * Below this horizontal length of the forward axis (pitch within about 1e-15 rad of ±90°, just above the rounding
 * noise of an exact ±90° pitch), heading and roll are degenerate (gimbal lock): the heading is then read from the
 * right axis and the roll comes out near 0. Dropping that horizontal part moves the rebuilt axes by at most twice it.
 */
const GIMBAL_LOCK_HORIZONTAL = 1e-15;

const scratchFrame = /* @__PURE__ */ new Float64Array(9);

/**
 * Writes the east-north-up frame at a geodetic position, in ECEF, without allocating: east to `out[0..2]`, north to
 * `out[3..5]` and up (the WGS84 ellipsoid normal, which geodetic latitude defines) to `out[6..8]`.
 *
 * East is (-sin λ, cos λ, 0) at every latitude, poles included, so the frame stays orthonormal, right-handed and
 * continuous in longitude; at ±90° north points along the meridian of `longitudeRad`. Latitudes beyond ±π/2 are
 * clamped.
 * @param longitudeRad - Longitude in radians.
 * @param latitudeRad - Geodetic latitude in radians.
 * @param out - Receives the 9 components (column-major ENU → ECEF rotation).
 * @returns `out`.
 */
export function enuFrame(longitudeRad: number, latitudeRad: number, out: Float64Array): Float64Array {
  scratchPosition[0] = longitudeRad;
  scratchPosition[1] = latitudeRad;
  return enuFrameAtArray(scratchPosition, out);
}

const scratchPosition = /* @__PURE__ */ new Float64Array(2);

/**
 * {@link enuFrame} with the longitude and latitude, in radians, read from `position[0..1]`: per-frame code passes
 * doubles in arrays, never as call arguments, which V8 boxes (ADR 0018).
 */
export function enuFrameAtArray(position: Float64Array, out: Float64Array): Float64Array {
  const longitudeRad = position[0] ?? 0;
  const latitude = position[1] ?? 0;
  // Comparisons, not Math.min and Math.max, which code not yet fully optimized calls with boxed doubles.
  const latRad = latitude > HALF_PI ? HALF_PI : latitude < -HALF_PI ? -HALF_PI : latitude;
  const sinLon = Math.sin(longitudeRad);
  const cosLon = Math.cos(longitudeRad);
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  out[0] = -sinLon;
  out[1] = cosLon;
  out[2] = 0;
  out[3] = -sinLat * cosLon;
  out[4] = -sinLat * sinLon;
  out[5] = cosLat;
  out[6] = cosLat * cosLon;
  out[7] = cosLat * sinLon;
  out[8] = sinLat;
  return out;
}

/** Writes frame · (east, north, up), the ECEF vector of local ENU components, to out[offset..offset + 2]. */
function writeLocalAsEcef(frame: Float64Array, east: number, north: number, up: number, out: Float64Array, o: number) {
  for (let i = 0; i < 3; i++)
    out[o + i] = (frame[i] ?? 0) * east + (frame[3 + i] ?? 0) * north + (frame[6 + i] ?? 0) * up;
}

/**
 * Writes the ECEF orientation of a body with the given heading, pitch and roll in the ENU frame at a geodetic
 * position, without allocating: the right axis to `out[0..2]`, forward to `out[3..5]` and up to `out[6..8]`.
 * @param longitudeRad - Longitude of the frame origin in radians.
 * @param latitudeRad - Geodetic latitude of the frame origin in radians.
 * @param headingRad - Heading in radians, clockwise from north.
 * @param pitchRad - Pitch in radians, positive nose up.
 * @param rollRad - Roll in radians, positive right wing down.
 * @param out - Receives the column-major body → ECEF rotation.
 * @returns `out`.
 */
export function headingPitchRollToRotationRad(
  longitudeRad: number,
  latitudeRad: number,
  headingRad: number,
  pitchRad: number,
  rollRad: number,
  out: Float64Array,
): Float64Array {
  const frame = enuFrame(longitudeRad, latitudeRad, scratchFrame);
  const sinH = Math.sin(headingRad);
  const cosH = Math.cos(headingRad);
  const sinP = Math.sin(pitchRad);
  const cosP = Math.cos(pitchRad);
  const sinR = Math.sin(rollRad);
  const cosR = Math.cos(rollRad);
  // Before roll: right = (cos h, -sin h, 0) and up = right × forward = (-sin h sin p, -cos h sin p, cos p) in ENU.
  const upE = -sinH * sinP;
  const upN = -cosH * sinP;
  writeLocalAsEcef(frame, cosR * cosH - sinR * upE, -cosR * sinH - sinR * upN, -sinR * cosP, out, 0);
  writeLocalAsEcef(frame, sinH * cosP, cosH * cosP, sinP, out, 3);
  writeLocalAsEcef(frame, sinR * cosH + cosR * upE, -sinR * sinH + cosR * upN, cosR * cosP, out, 6);
  return out;
}

function dotColumn(frame: Float64Array, frameColumn: number, rotation: ArrayLike<number>, column: number): number {
  let sum = 0;
  for (let i = 0; i < 3; i++) sum += (frame[3 * frameColumn + i] ?? 0) * (rotation[3 * column + i] ?? 0);
  return sum;
}

/**
 * Reads heading, pitch and roll back from an ECEF orientation (the inverse of {@link headingPitchRollToRotationRad}),
 * without allocating. Heading is in [0, 2π), pitch in [-π/2, π/2] and roll in [-π, π]. At pitch ±π/2 (gimbal lock)
 * only heading ∓ roll is defined; the heading is then taken from the right axis and the roll is near 0. Rebuilding
 * the rotation from the result reproduces the input at every pitch.
 * @param longitudeRad - Longitude of the frame origin in radians.
 * @param latitudeRad - Geodetic latitude of the frame origin in radians.
 * @param rotation - Column-major body → ECEF rotation (right, forward, up columns).
 * @param out - Receives heading, pitch and roll at `out[0]`, `out[1]` and `out[2]`, in radians.
 * @returns `out`.
 */
export function rotationToHeadingPitchRollRad(
  longitudeRad: number,
  latitudeRad: number,
  rotation: ArrayLike<number>,
  out: Float64Array,
): Float64Array {
  const frame = enuFrame(longitudeRad, latitudeRad, scratchFrame);
  const forwardE = dotColumn(frame, 0, rotation, 1);
  const forwardN = dotColumn(frame, 1, rotation, 1);
  const horizontal = Math.hypot(forwardE, forwardN);
  const pitchRad = Math.atan2(dotColumn(frame, 2, rotation, 1), horizontal);
  const headingRad =
    horizontal < GIMBAL_LOCK_HORIZONTAL
      ? Math.atan2(-dotColumn(frame, 1, rotation, 0), dotColumn(frame, 0, rotation, 0))
      : Math.atan2(forwardE, forwardN);
  // Roll measured against the un-rolled right and up axes of this heading and pitch, so the result stays consistent
  // with the heading even where the heading itself is poorly conditioned.
  const sinH = Math.sin(headingRad);
  const cosH = Math.cos(headingRad);
  const sinP = Math.sin(pitchRad);
  const rightE = dotColumn(frame, 0, rotation, 0);
  const rightN = dotColumn(frame, 1, rotation, 0);
  const rightU = dotColumn(frame, 2, rotation, 0);
  const rightAlongRight0 = rightE * cosH - rightN * sinH;
  const rightAlongUp0 = -rightE * sinH * sinP - rightN * cosH * sinP + rightU * Math.cos(pitchRad);
  const wrappedHeading = headingRad < 0 ? headingRad + TWO_PI : headingRad + 0;
  out[0] = wrappedHeading >= TWO_PI ? 0 : wrappedHeading;
  out[1] = pitchRad;
  out[2] = Math.atan2(-rightAlongUp0, rightAlongRight0);
  return out;
}

/** Heading, pitch and roll in degrees (aerospace convention, see {@link headingPitchRollToRotationDeg}). */
export interface HeadingPitchRollDeg {
  /** Heading in degrees, clockwise from north. */
  readonly headingDeg: number;
  /** Pitch in degrees, positive nose up. */
  readonly pitchDeg: number;
  /** Roll in degrees, positive right wing down. */
  readonly rollDeg: number;
}

const DEG_TO_RAD = Math.PI / 180;

/**
 * Builds the east-north-up frame at a longitude and latitude in degrees (see {@link enuFrame}).
 * @param lonDeg - Longitude in degrees.
 * @param latDeg - Geodetic latitude in degrees.
 * @param out - Receives east, north and up in ECEF; a new array when omitted.
 * @returns `out`.
 */
export function enuFrameDeg(lonDeg: number, latDeg: number, out = new Float64Array(9)): Float64Array {
  return enuFrame(lonDeg * DEG_TO_RAD, latDeg * DEG_TO_RAD, out);
}

/**
 * Builds the ECEF orientation (right, forward, up columns) of a body with the given heading, pitch and roll in the
 * east-north-up frame at a longitude and latitude in degrees (see {@link headingPitchRollToRotationRad}).
 * @param lonDeg - Longitude of the frame origin in degrees.
 * @param latDeg - Geodetic latitude of the frame origin in degrees.
 * @param hpr - Heading, pitch and roll in degrees.
 * @param out - Receives the column-major rotation; a new array when omitted.
 * @returns `out`.
 */
export function headingPitchRollToRotationDeg(
  lonDeg: number,
  latDeg: number,
  hpr: HeadingPitchRollDeg,
  out = new Float64Array(9),
): Float64Array {
  return headingPitchRollToRotationRad(
    lonDeg * DEG_TO_RAD,
    latDeg * DEG_TO_RAD,
    hpr.headingDeg * DEG_TO_RAD,
    hpr.pitchDeg * DEG_TO_RAD,
    hpr.rollDeg * DEG_TO_RAD,
    out,
  );
}

/**
 * Reads heading, pitch and roll in degrees from an ECEF orientation (see {@link rotationToHeadingPitchRollRad}).
 * @param lonDeg - Longitude of the frame origin in degrees.
 * @param latDeg - Geodetic latitude of the frame origin in degrees.
 * @param rotation - Column-major body → ECEF rotation (right, forward, up columns).
 * @returns Heading in [0°, 360°), pitch in [-90°, 90°] and roll in [-180°, 180°].
 */
export function rotationToHeadingPitchRollDeg(
  lonDeg: number,
  latDeg: number,
  rotation: ArrayLike<number>,
): HeadingPitchRollDeg {
  const out = rotationToHeadingPitchRollRad(lonDeg * DEG_TO_RAD, latDeg * DEG_TO_RAD, rotation, new Float64Array(3));
  const headingDeg = (out[0] ?? Number.NaN) / DEG_TO_RAD;
  return {
    headingDeg: headingDeg >= 360 ? 0 : headingDeg,
    pitchDeg: (out[1] ?? Number.NaN) / DEG_TO_RAD,
    rollDeg: (out[2] ?? Number.NaN) / DEG_TO_RAD,
  };
}
