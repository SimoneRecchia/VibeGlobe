// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
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
