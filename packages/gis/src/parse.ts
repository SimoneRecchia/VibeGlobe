/**
 * Coordinate parsing: reads what {@link formatCoordinate} writes, and the common hand-typed variants (signed decimal
 * degrees, ASCII marks, space-separated degrees minutes seconds, hemisphere letters before or after, decimal commas).
 */
import type { LonLat } from './format.js';
import { fromUtm } from './utm.js';

const UTM = /^(\d{1,2})\s*([C-HJ-NP-X])\s+(\d+(?:\.\d+)?)\s*(?:m\s*)?E?\s+(\d+(?:\.\d+)?)\s*(?:m\s*)?N?$/i;
/** Every token a geographic coordinate may contain. */
const TOKEN = /[+-]?\d+(?:\.\d+)?|[°'"]|[NSEW]|[,;]|\s+/gi;
const MARK_LEVEL: Readonly<Record<string, number>> = { '°': 0, "'": 1, '"': 2 };

interface Angle {
  /** The numbers as typed, so signs on minutes and seconds can be refused. */
  readonly values: string[];
  readonly levels: number[];
  hemisphere?: string;
}

/** Unifies typographic marks and decimal commas: a comma between digits is decimal when the text has no point. */
function normalize(text: string): string {
  let result = text
    .trim()
    .replace(/[º˚]/g, '°')
    .replace(/[′’‘`´]/g, "'")
    .replace(/[″”“]|''/g, '"');
  if (!result.includes('.')) result = result.replace(/(\d),(\d)/g, '$1.$2');
  return result;
}

/** Groups tokens into angles: a new angle starts after a separator or a trailing hemisphere, or when a mark repeats. */
function groupAngles(tokens: readonly string[]): Angle[] | undefined {
  const angles: Angle[] = [];
  let current: Angle = { values: [], levels: [] };
  const close = (): void => {
    if (current.values.length > 0 || current.hemisphere !== undefined) angles.push(current);
    current = { values: [], levels: [] };
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? '';
    if (/^\s+$/.test(token)) continue;
    if (token === ',' || token === ';') {
      close();
    } else if (/^[NSEW]$/i.test(token)) {
      const hemisphere = token.toUpperCase();
      if (current.values.length === 0) {
        if (current.hemisphere !== undefined) return undefined;
        current.hemisphere = hemisphere;
      } else if (current.hemisphere === undefined) {
        current.hemisphere = hemisphere;
        close();
      } else {
        // The letter that leads the next angle (`N 45 27 E 9 11`).
        close();
        current.hemisphere = hemisphere;
      }
    } else if (token in MARK_LEVEL) {
      return undefined;
    } else {
      const next = tokens[i + 1];
      const level = next !== undefined && next in MARK_LEVEL ? (MARK_LEVEL[next] ?? 0) : undefined;
      if (level !== undefined) i++;
      const previous = current.levels.at(-1);
      if (level !== undefined && previous !== undefined && level <= previous) close();
      current.values.push(token);
      current.levels.push(level ?? (current.levels.at(-1) ?? -1) + 1);
    }
  }
  close();
  // Unmarked degrees, minutes and seconds of both coordinates in one run: split it in half.
  const only = angles[0];
  if (angles.length === 1 && only !== undefined && only.hemisphere === undefined) {
    const half = only.values.length / 2;
    if (![1, 2, 3].includes(half)) return undefined;
    const levels = only.levels.slice(0, half);
    return [
      { values: only.values.slice(0, half), levels },
      { values: only.values.slice(half), levels },
    ];
  }
  return angles;
}

/** Degrees of an angle; undefined for out-of-order parts, signed minutes, or minutes and seconds of 60 or more. */
function degreesOf(angle: Angle): number | undefined {
  const { values, levels } = angle;
  const first = values[0];
  if (first === undefined || values.length > 3) return undefined;
  let magnitude = 0;
  for (let i = 0; i < values.length; i++) {
    const raw = values[i] ?? '';
    const value = Math.abs(Number(raw));
    if (levels[i] !== i) return undefined;
    if (i > 0 && (/^[+-]/.test(raw) || value >= 60)) return undefined;
    if (i < values.length - 1 && !Number.isInteger(value)) return undefined;
    magnitude += value / 60 ** i;
  }
  const negative = first.startsWith('-');
  const southOrWest = angle.hemisphere === 'S' || angle.hemisphere === 'W';
  if (negative && angle.hemisphere !== undefined) return undefined;
  return negative || southOrWest ? -magnitude : magnitude;
}

/**
 * Reads a WGS84 position from text, or returns undefined when the text is not a coordinate. Accepted forms:
 * decimal degrees (`45.4643, 9.19`, `45.4643°N 9.19°E`, `-33.9 18.4`), degrees-minutes-seconds (`45°27′51.6″N
 * 9°11′24″E`, `45 27 51.6 N 9 11 24 E`, `N 45° 27.86' E 9° 11.4'`) and UTM (`32T 514880 5034425`, the band letter giving
 * the hemisphere). Without hemisphere letters the latitude comes first; with them, the letters decide. A comma between
 * digits is a decimal comma when the text contains no point.
 *
 * @param text - What the user typed.
 */
export function parseCoordinate(text: string): LonLat | undefined {
  const normalized = normalize(text);
  const utm = UTM.exec(normalized);
  if (utm !== null) {
    try {
      const position = fromUtm({
        zone: Number(utm[1]),
        band: utm[2] ?? '',
        eastingMeters: Number(utm[3]),
        northingMeters: Number(utm[4]),
      });
      return Math.abs(position.latitudeDeg) <= 90 ? position : undefined;
    } catch {
      return undefined;
    }
  }
  const tokens = normalized.match(TOKEN);
  if (tokens === null || tokens.join('') !== normalized) return undefined;
  const angles = groupAngles(tokens);
  if (angles?.length !== 2) return undefined;
  const [first, second] = angles as [Angle, Angle];
  const isLongitude = (angle: Angle): boolean => angle.hemisphere === 'E' || angle.hemisphere === 'W';
  const isLatitude = (angle: Angle): boolean => angle.hemisphere === 'N' || angle.hemisphere === 'S';
  if ((isLatitude(first) && isLatitude(second)) || (isLongitude(first) && isLongitude(second))) return undefined;
  const swap = isLongitude(first) || isLatitude(second);
  const latitudeDeg = degreesOf(swap ? second : first);
  const longitudeDeg = degreesOf(swap ? first : second);
  if (latitudeDeg === undefined || longitudeDeg === undefined) return undefined;
  if (Math.abs(latitudeDeg) > 90 || Math.abs(longitudeDeg) > 180) return undefined;
  return { longitudeDeg, latitudeDeg };
}
