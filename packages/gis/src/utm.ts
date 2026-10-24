// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** UTM grid zones and latitude bands (NIMA TM 8358.2), with the Norway and Svalbard zone exceptions. */
import { transformCoordinates } from './crs.js';

/** A position on the UTM grid. */
export interface UtmCoordinate {
  /** Zone number, 1–60. */
  readonly zone: number;
  /** Latitude band letter, C–X without I and O; N and later letters lie in the northern hemisphere. */
  readonly band: string;
  readonly eastingMeters: number;
  readonly northingMeters: number;
}

/** Latitude bands from 80°S northwards, 8° each; X spans 72°N–84°N. */
const BANDS = 'CDEFGHJKLMNPQRSTUVWX';
/** Latitudes the UTM grid covers; beyond them the polar stereographic grid (UPS) applies. */
const UTM_MIN_LATITUDE_DEG = -80;
const UTM_MAX_LATITUDE_DEG = 84;
/** Bands C to M lie south of the equator. */
const SOUTHERN_BANDS = 10;

function wrapLongitude(longitudeDeg: number): number {
  const wrapped = ((((longitudeDeg + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 && longitudeDeg > 0 ? 180 : wrapped;
}

/** The latitude band letter of a latitude, or undefined outside the UTM grid. */
export function utmBand(latitudeDeg: number): string | undefined {
  if (!(latitudeDeg >= UTM_MIN_LATITUDE_DEG && latitudeDeg <= UTM_MAX_LATITUDE_DEG)) return undefined;
  const index = Math.min(Math.floor((latitudeDeg - UTM_MIN_LATITUDE_DEG) / 8), BANDS.length - 1);
  // Tiny negative latitudes round to 80° above the grid's start: keep them in the southern band, like their northing.
  return BANDS[latitudeDeg < 0 ? Math.min(index, SOUTHERN_BANDS - 1) : index];
}

/** The UTM zone of a position, with the exceptions of zone 32V (Norway) and zones 31X–37X (Svalbard). */
export function utmZone(longitudeDeg: number, latitudeDeg: number): number {
  const lon = wrapLongitude(longitudeDeg);
  if (latitudeDeg >= 56 && latitudeDeg < 64 && lon >= 3 && lon < 12) return 32;
  if (latitudeDeg >= 72 && lon >= 0 && lon < 42) return lon < 9 ? 31 : lon < 21 ? 33 : lon < 33 ? 35 : 37;
  return Math.min(Math.floor((lon + 180) / 6) + 1, 60);
}

function utmCode(zone: number, north: boolean): string {
  return `EPSG:32${north ? 6 : 7}${String(zone).padStart(2, '0')}`;
}

/**
 * The UTM coordinate of a WGS84 position in its own zone, or undefined outside the UTM grid (south of 80°S or north of
 * 84°N).
 *
 * @param longitudeDeg - WGS84 longitude in degrees.
 * @param latitudeDeg - WGS84 latitude in degrees.
 */
export function toUtm(longitudeDeg: number, latitudeDeg: number): UtmCoordinate | undefined {
  const band = utmBand(latitudeDeg);
  if (band === undefined || !Number.isFinite(longitudeDeg)) return undefined;
  const zone = utmZone(longitudeDeg, latitudeDeg);
  const { x, y } = transformCoordinates(
    { x: wrapLongitude(longitudeDeg), y: latitudeDeg },
    'EPSG:4326',
    utmCode(zone, latitudeDeg >= 0),
  );
  return { zone, band, eastingMeters: x, northingMeters: y };
}

/**
 * The WGS84 position of a UTM coordinate; the band letter selects the hemisphere. Throws a RangeError for a zone
 * outside 1–60, an unknown band letter, or zone 32, 34 or 36 in band X (Svalbard's exceptions).
 */
export function fromUtm(utm: UtmCoordinate): { longitudeDeg: number; latitudeDeg: number } {
  const bandIndex = BANDS.indexOf(utm.band.toUpperCase());
  // Zones 32, 34 and 36 do not exist in band X (Svalbard).
  const svalbardGap = utm.band.toUpperCase() === 'X' && (utm.zone === 32 || utm.zone === 34 || utm.zone === 36);
  if (
    !Number.isInteger(utm.zone) ||
    utm.zone < 1 ||
    utm.zone > 60 ||
    bandIndex < 0 ||
    utm.band.length !== 1 ||
    svalbardGap
  )
    throw new RangeError(`Invalid UTM zone ${utm.zone}${utm.band}`);
  const north = bandIndex >= SOUTHERN_BANDS;
  const { x, y } = transformCoordinates(
    { x: utm.eastingMeters, y: utm.northingMeters },
    utmCode(utm.zone, north),
    'EPSG:4326',
  );
  return { longitudeDeg: x, latitudeDeg: y };
}
