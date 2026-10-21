/** A point in a flat map projection, in meters. */
export interface ProjectedPointMeters {
  /** Easting, in meters. */
  readonly xMeters: number;
  /** Northing, in meters. */
  readonly yMeters: number;
}

/** A geodetic longitude and latitude, in degrees. */
export interface LonLatDeg {
  /** Longitude in degrees, positive east. */
  readonly lonDeg: number;
  /** Geodetic latitude in degrees, positive north. */
  readonly latDeg: number;
}
