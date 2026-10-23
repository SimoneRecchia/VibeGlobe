// The Sun's apparent direction from the Earth's center, for sun lighting by date and time (F396). Low-precision solar
// coordinates (Meeus, Astronomical Algorithms, 2nd ed., ch. 25: about 0.01°) and Greenwich mean sidereal time (ch. 12),
// written from the published formulas. Earth-fixed axes: x toward 0° N 0° E, y toward 0° N 90° E, z toward the North
// Pole, as the engine's ECEF. Polar motion, nutation in right ascension and ΔT each move the result by less than 0.01°.

const DEG = Math.PI / 180;
const MS_PER_DAY = 86_400_000;
/** The Julian day of the Unix epoch. */
const JD_UNIX_EPOCH = 2_440_587.5;
/** The Julian day of J2000.0. */
const JD_J2000 = 2_451_545;

/** Where the Sun is overhead: the sub-solar point, in degrees. */
export interface SubsolarPoint {
  readonly latitudeDeg: number;
  /** In [−180, 180). */
  readonly longitudeDeg: number;
}

/** Wraps an angle in degrees into [0, 360). */
function wrapDeg(angleDeg: number): number {
  const wrapped = angleDeg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * The sub-solar point at a time given as Unix milliseconds (UTC): the Sun's apparent declination and the longitude where
 * its Greenwich hour angle is zero. Accurate to about 0.01° between 1950 and 2050 (`sun-position.test.ts`).
 */
export function subsolarPoint(utcMs: number): SubsolarPoint {
  const daysFromJ2000 = utcMs / MS_PER_DAY + JD_UNIX_EPOCH - JD_J2000;
  const t = daysFromJ2000 / 36_525;
  const meanLongitudeDeg = 280.46646 + 36_000.76983 * t + 0.0003032 * t * t;
  const meanAnomalyRad = (357.52911 + 35_999.05029 * t - 0.0001537 * t * t) * DEG;
  const centerDeg =
    (1.914602 - 0.004817 * t - 0.000014 * t * t) * Math.sin(meanAnomalyRad) +
    (0.019993 - 0.000101 * t) * Math.sin(2 * meanAnomalyRad) +
    0.000289 * Math.sin(3 * meanAnomalyRad);
  const nodeRad = (125.04 - 1934.136 * t) * DEG;
  // Apparent longitude: aberration and nutation in longitude.
  const longitudeRad = (meanLongitudeDeg + centerDeg - 0.00569 - 0.00478 * Math.sin(nodeRad)) * DEG;
  const meanObliquityDeg = 23.439291111 - (46.815 * t + 0.00059 * t * t - 0.001813 * t * t * t) / 3600;
  const obliquityRad = (meanObliquityDeg + 0.00256 * Math.cos(nodeRad)) * DEG;
  const rightAscensionDeg = Math.atan2(Math.cos(obliquityRad) * Math.sin(longitudeRad), Math.cos(longitudeRad)) / DEG;
  const declinationDeg = Math.asin(Math.sin(obliquityRad) * Math.sin(longitudeRad)) / DEG;
  const siderealDeg = 280.46061837 + 360.98564736629 * daysFromJ2000 + 0.000387933 * t * t - (t * t * t) / 38_710_000;
  const longitudeDeg = wrapDeg(rightAscensionDeg - siderealDeg + 180) - 180;
  return { latitudeDeg: declinationDeg, longitudeDeg };
}

/** Writes the unit vector from the Earth's center toward the Sun, in ECEF axes, at a time in Unix milliseconds (UTC). */
export function sunDirectionEcef(utcMs: number, out: Float64Array): Float64Array {
  const { latitudeDeg, longitudeDeg } = subsolarPoint(utcMs);
  const latitudeRad = latitudeDeg * DEG;
  const longitudeRad = longitudeDeg * DEG;
  out[0] = Math.cos(latitudeRad) * Math.cos(longitudeRad);
  out[1] = Math.cos(latitudeRad) * Math.sin(longitudeRad);
  out[2] = Math.sin(latitudeRad);
  return out;
}
