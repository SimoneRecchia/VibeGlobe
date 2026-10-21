/**
 * Coordinate reference systems and transforms between them, through proj4js (MIT). Definitions live in a registry of
 * this module, not in proj4's global one, so registering a system never changes another library's state.
 */
import proj4 from 'proj4';

/** A point in a reference system: longitude and latitude in degrees for geographic systems, else easting and northing. */
export interface CrsPoint {
  /** Longitude in degrees (geographic systems) or easting in the system's unit, usually meters. */
  readonly x: number;
  /** Latitude in degrees (geographic systems) or northing. */
  readonly y: number;
  /** Height in meters, when known. */
  readonly z?: number;
}

/**
 * Built-in systems, as PROJ strings. ETRS89 coincides with WGS84 to within about a meter in the EPSG database's
 * null transformation (EPSG:1149), which is also what PROJ applies without a time-dependent grid.
 */
const BUILT_IN: Readonly<Record<string, string>> = {
  'EPSG:4326': '+proj=longlat +datum=WGS84 +no_defs',
  'EPSG:3857':
    '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs',
  'EPSG:32632': '+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs',
  'EPSG:32633': '+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs',
  'EPSG:4258': '+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs',
  'EPSG:25832': '+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
  'EPSG:25833': '+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
};

const definitions = new Map<string, string>(Object.entries(BUILT_IN));
const converters = new Map<string, proj4.Converter>();

/** Codes of every system known to {@link transformCoordinates}, built-in and defined. */
export function crsCodes(): string[] {
  return [...definitions.keys()];
}

/**
 * Registers a custom reference system from a PROJ string or OGC WKT, under a code of the application's choice (for
 * example `'EPSG:3003'` or `'my-grid'`). Redefining a code replaces it. Throws when proj4js cannot parse the definition.
 *
 * @param code - Name to refer to the system by.
 * @param definition - PROJ string (`+proj=tmerc ...`) or WKT.
 */
export function defineCrs(code: string, definition: string): void {
  proj4(definition, BUILT_IN['EPSG:4326'] ?? '');
  definitions.set(code, definition);
  for (const key of converters.keys())
    if (key.startsWith(`${code}\n`) || key.endsWith(`\n${code}`)) converters.delete(key);
}

/** WGS84 / UTM zone codes: EPSG:326zz (north) and EPSG:327zz (south), zz from 01 to 60. */
const WGS84_UTM_CODE = /^EPSG:32([67])(0[1-9]|[1-5]\d|60)$/;

function definitionOf(code: string): string {
  const utm = WGS84_UTM_CODE.exec(code);
  if (utm !== null && !definitions.has(code)) {
    const south = utm[1] === '7' ? ' +south' : '';
    definitions.set(code, `+proj=utm +zone=${Number(utm[2])}${south} +datum=WGS84 +units=m +no_defs`);
  }
  const definition = definitions.get(code);
  if (definition === undefined) throw new RangeError(`Unknown reference system "${code}"; register it with defineCrs`);
  return definition;
}

function converter(from: string, to: string): proj4.Converter {
  const key = `${from}\n${to}`;
  let found = converters.get(key);
  if (found === undefined) {
    found = proj4(definitionOf(from), definitionOf(to));
    converters.set(key, found);
  }
  return found;
}

/**
 * Transforms a point from one reference system to another. Geographic coordinates are longitude first, in degrees.
 * Throws a RangeError for an unknown code or a point the transform cannot map (a non-finite result).
 *
 * @param point - Coordinates in `fromCrs`.
 * @param fromCrs - Code of the source system, for example `'EPSG:4326'`.
 * @param toCrs - Code of the target system, for example `'EPSG:32632'`.
 */
export function transformCoordinates(point: CrsPoint, fromCrs: string, toCrs: string): CrsPoint {
  const input = point.z === undefined ? [point.x, point.y] : [point.x, point.y, point.z];
  const output = converter(fromCrs, toCrs).forward(input);
  const [x = NaN, y = NaN, z] = output;
  if (!Number.isFinite(x) || !Number.isFinite(y))
    throw new RangeError(`(${point.x}, ${point.y}) cannot be transformed from ${fromCrs} to ${toCrs}`);
  return z === undefined || point.z === undefined ? { x, y } : { x, y, z };
}
