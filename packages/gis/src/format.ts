/**
 * Coordinate formatting: decimal degrees, degrees-minutes-seconds and UTM, shared by the readout and the search box so
 * what one shows the other reads back ({@link parseCoordinate}).
 */
import { toUtm } from './utm.js';

/** A WGS84 position in degrees. */
export interface LonLat {
  readonly longitudeDeg: number;
  readonly latitudeDeg: number;
}

/** Coordinate notations. */
export type CoordinateFormat = 'decimal' | 'dms' | 'utm';

/** Options of {@link formatCoordinate}. */
export interface CoordinateFormatOptions {
  /**
   * Decimal places: of degrees for 'decimal' (default 5, about 1 m), of seconds for 'dms' (default 1, about 3 m) and of
   * meters for 'utm' (default 0).
   */
  readonly precision?: number;
  /** Decimal separator (default '.'); ',' for locales such as Italian. {@link parseCoordinate} reads both. */
  readonly decimalSeparator?: '.' | ',';
}

const DEFAULT_PRECISION: Readonly<Record<CoordinateFormat, number>> = { decimal: 5, dms: 1, utm: 0 };

function checkPrecision(precision: number): number {
  if (!Number.isInteger(precision) || precision < 0 || precision > 12)
    throw new RangeError(`Precision must be an integer from 0 to 12, got ${precision}`);
  return precision;
}

/** Wraps a longitude to (-180, 180], keeping 180 east. */
function wrapLongitude(longitudeDeg: number): number {
  const wrapped = ((((longitudeDeg - 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 ? 180 : wrapped;
}

/** `value` rounded to `precision` decimal places, as a scaled integer (exact digit arithmetic). */
function scaled(value: number, precision: number): number {
  return Math.round(value * 10 ** precision);
}

/** Writes a non-negative scaled integer with `precision` decimal places and at least `intDigits` integer digits. */
function digits(units: number, precision: number, intDigits: number, separator: string): string {
  const scale = 10 ** precision;
  const whole = String(Math.floor(units / scale)).padStart(intDigits, '0');
  return precision === 0 ? whole : `${whole}${separator}${String(units % scale).padStart(precision, '0')}`;
}

function formatDecimal(value: number, precision: number, positive: string, negative: string, sep: string): string {
  const units = scaled(Math.abs(value), precision);
  return `${digits(units, precision, 1, sep)}°${value < 0 && units > 0 ? negative : positive}`;
}

function formatDms(value: number, precision: number, positive: string, negative: string, sep: string): string {
  const units = scaled(Math.abs(value) * 3600, precision);
  const perSecond = 10 ** precision;
  const degrees = Math.floor(units / (3600 * perSecond));
  const minutes = Math.floor(units / (60 * perSecond)) % 60;
  const seconds = units % (60 * perSecond);
  const hemisphere = value < 0 && units > 0 ? negative : positive;
  return `${degrees}°${String(minutes).padStart(2, '0')}′${digits(seconds, precision, 2, sep)}″${hemisphere}`;
}

/**
 * Formats a WGS84 position, latitude first: `45.46433°N 9.19000°E`, `45°27′51.6″N 9°11′24.0″E` or `32T 514880 5034425`
 * (zone, latitude band, easting, northing). Rounding carries over, so seconds and minutes never read 60. Returns
 * undefined for UTM outside its latitudes (80°S to 84°N). Throws a RangeError for a latitude outside ±90°, a non-finite
 * value or an invalid precision.
 *
 * @param position - WGS84 position in degrees.
 * @param format - Notation.
 * @param options - Precision and decimal separator.
 */
export function formatCoordinate(
  position: LonLat,
  format: CoordinateFormat,
  options: CoordinateFormatOptions = {},
): string | undefined {
  const { latitudeDeg } = position;
  if (!Number.isFinite(position.longitudeDeg) || !(Math.abs(latitudeDeg) <= 90))
    throw new RangeError(`Invalid position (${position.longitudeDeg}, ${latitudeDeg})`);
  const precision = checkPrecision(options.precision ?? DEFAULT_PRECISION[format]);
  const sep = options.decimalSeparator ?? '.';
  const longitudeDeg = wrapLongitude(position.longitudeDeg);
  if (format === 'utm') {
    const utm = toUtm(longitudeDeg, latitudeDeg);
    if (utm === undefined) return undefined;
    const easting = digits(scaled(utm.eastingMeters, precision), precision, 1, sep);
    const northing = digits(scaled(utm.northingMeters, precision), precision, 1, sep);
    return `${utm.zone}${utm.band} ${easting} ${northing}`;
  }
  const write = format === 'dms' ? formatDms : formatDecimal;
  return `${write(latitudeDeg, precision, 'N', 'S', sep)} ${write(longitudeDeg, precision, 'E', 'W', sep)}`;
}
