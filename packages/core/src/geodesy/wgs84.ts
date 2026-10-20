/** A reference ellipsoid of revolution. */
export interface Ellipsoid {
  /** Equatorial radius, in meters. */
  readonly semiMajorAxisMeters: number;
  /** Polar radius, in meters. */
  readonly semiMinorAxisMeters: number;
  /** Flattening f = (a - b) / a. */
  readonly flattening: number;
  /** First eccentricity squared e² = f (2 - f). */
  readonly firstEccentricitySquared: number;
}

const WGS84_FLATTENING = 1 / 298.257223563;

/**
 * The WGS84 ellipsoid (EPSG:7030): the datum for every position, measurement and computation
 * in the engine, whatever the display projection.
 */
export const WGS84: Ellipsoid = {
  semiMajorAxisMeters: 6378137,
  semiMinorAxisMeters: 6378137 * (1 - WGS84_FLATTENING),
  flattening: WGS84_FLATTENING,
  firstEccentricitySquared: WGS84_FLATTENING * (2 - WGS84_FLATTENING),
};
