import { GlobeError } from './errors.js';
import type { GeoPosition, GlobeEvents, GlobeOptions, ScreenPoint, ViewInit } from './types.js';

// Beyond any view the camera can reach: the 0.5 m minimum eye height (camera-state.ts) is about zoom 27 at the equator.
const MAX_ZOOM = 28;

function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new GlobeError('invalid-coordinate', `${name} must be a finite number, got ${describeInput(value)}`);
  }
  return value;
}

function inRange(value: unknown, name: string, min: number, max: number): number {
  const number = finite(value, name);
  if (number < min || number > max) {
    throw new GlobeError('invalid-coordinate', `${name} must be between ${min} and ${max}, got ${number}`);
  }
  return number;
}

/** A validated camera target: every field present, degrees, within range. */
export interface ValidView {
  longitudeDeg: number;
  latitudeDeg: number;
  zoom: number;
  headingDeg: number;
  tiltDeg: number;
}

/** Validates a camera target at the API boundary; missing fields come from `current`. Throws a typed GlobeError. */
export function validateView(view: unknown, current: ValidView): ValidView {
  if (view === null || typeof view !== 'object') {
    throw new GlobeError('invalid-coordinate', `A view must be an object, got ${describeInput(view)}`);
  }
  const input = view as ViewInit;
  return {
    longitudeDeg:
      input.longitudeDeg === undefined ? current.longitudeDeg : inRange(input.longitudeDeg, 'longitudeDeg', -540, 540),
    latitudeDeg:
      input.latitudeDeg === undefined ? current.latitudeDeg : inRange(input.latitudeDeg, 'latitudeDeg', -90, 90),
    zoom: input.zoom === undefined ? current.zoom : inRange(input.zoom, 'zoom', -2, MAX_ZOOM),
    headingDeg: input.headingDeg === undefined ? current.headingDeg : finite(input.headingDeg, 'headingDeg'),
    tiltDeg: input.tiltDeg === undefined ? current.tiltDeg : inRange(input.tiltDeg, 'tiltDeg', 0, 89),
  };
}

/** Numeric options and their ranges. */
const NUMBER_OPTIONS = [
  ['resolutionScale', 0.1, 4],
  ['maxScreenErrorPx', 0.1, 64],
  ['manualClockStepMs', 0.001, 1000],
  ['imageryFadeMs', 0, 5000],
  ['terrainClearanceMeters', 0, 10_000],
] as const;

/** Validates the logging options (F120). */
function validateLogging(level: unknown, sink: unknown): void {
  if (level !== undefined && !['debug', 'info', 'warn', 'error', 'silent'].includes(level as string))
    throw new GlobeError(
      'invalid-option',
      `logLevel must be debug, info, warn, error or silent, got ${describeInput(level)}`,
    );
  if (sink !== undefined && typeof sink !== 'function')
    throw new GlobeError('invalid-option', 'logSink must be a function');
}

/** Validates the options of createGlobe at the API boundary. Throws a typed GlobeError naming the bad option. */
export function validateOptions(options: unknown): GlobeOptions {
  if (options === null || typeof options !== 'object') {
    throw new GlobeError('invalid-option', `createGlobe options must be an object, got ${describeInput(options)}`);
  }
  const input = options as Partial<Record<keyof GlobeOptions, unknown>>;
  if (input.container === null || typeof input.container !== 'object') {
    throw new GlobeError('invalid-option', 'container must be an element');
  }
  if (typeof input.renderer !== 'function')
    throw new GlobeError('invalid-option', 'renderer must be a renderer factory');
  if (input.controls !== undefined && typeof input.controls !== 'function') {
    throw new GlobeError('invalid-option', 'controls must be a controls factory');
  }
  if (typeof input.baseImageryUrl !== 'string' || input.baseImageryUrl.length === 0) {
    throw new GlobeError('invalid-option', 'baseImageryUrl must be a non-empty string');
  }
  for (const [name, min, max] of NUMBER_OPTIONS) {
    const value = input[name];
    if (value !== undefined) {
      const number = typeof value === 'number' ? value : NaN;
      if (!(number >= min && number <= max)) {
        throw new GlobeError(
          'invalid-option',
          `${name} must be a number between ${min} and ${max}, got ${describeInput(value)}`,
        );
      }
    }
  }
  validateLogging(input.logLevel, input.logSink);
  const minLevel = input.minSurfaceLevel;
  if (
    minLevel !== undefined &&
    !(Number.isInteger(minLevel) && (minLevel as number) >= 2 && (minLevel as number) <= 8)
  ) {
    throw new GlobeError(
      'invalid-option',
      `minSurfaceLevel must be an integer between 2 and 8, got ${describeInput(minLevel)}`,
    );
  }
  if (input.view !== undefined) validateView(input.view, DEFAULT_VIEW);
  validateImagery(input.imagery, input.workers);
  validateTerrain(input.terrain, input.workers);
  const memory = input.memory as Partial<Record<string, unknown>> | undefined;
  if (memory !== undefined) {
    if (memory === null || typeof memory !== 'object')
      throw new GlobeError('invalid-option', 'memory must be an object');
    for (const name of ['gpuBudgetBytes', 'ramBudgetBytes']) {
      const value = memory[name];
      if (value !== undefined && !(Number.isInteger(value) && (value as number) >= 1)) {
        throw new GlobeError(
          'invalid-option',
          `memory.${name} must be a positive integer, got ${describeInput(value)}`,
        );
      }
    }
  }
  return options as GlobeOptions;
}

/** Imagery sources need the worker pool that decodes their tiles: a missing one is an error, never a silent fallback. */
function validateImagery(imagery: unknown, workers: unknown): void {
  if (imagery === undefined) return;
  if (!Array.isArray(imagery)) throw new GlobeError('invalid-option', 'imagery must be an array of imagery sources');
  const ids = new Set<string>();
  for (const source of imagery as unknown[]) {
    const candidate = source as Partial<Record<string, unknown>> | null;
    if (
      candidate === null ||
      typeof candidate !== 'object' ||
      typeof candidate['id'] !== 'string' ||
      typeof candidate['request'] !== 'function' ||
      typeof candidate['transport'] !== 'object' ||
      typeof candidate['tiling'] !== 'object'
    ) {
      throw new GlobeError('invalid-option', `imagery entries must be imagery sources, got ${describeInput(source)}`);
    }
    if (ids.has(candidate['id']))
      throw new GlobeError('invalid-option', `imagery ids must be unique: ${candidate['id']}`);
    ids.add(candidate['id']);
  }
  const factory = workers as Partial<Record<string, unknown>> | null | undefined;
  if (
    imagery.length > 0 &&
    (typeof factory !== 'object' || factory === null || typeof factory['create'] !== 'function')
  ) {
    throw new GlobeError(
      'invalid-option',
      'workers is required when imagery is set: pass createWorkers() from @vibeglobe/worker',
    );
  }
}

const TERRAIN_DECODERS: readonly string[] = ['terrarium', 'terrain-rgb', 'quantized-mesh', 'custom'];

/**
 * A terrain source: a tile source with a known decoder, a declared vertical datum (F133) and a geometric error per
 * level; like imagery, it needs the worker pool.
 */
function validateTerrain(terrain: unknown, workers: unknown): void {
  if (terrain === undefined) return;
  const source = terrain as Partial<Record<string, unknown>> | null;
  if (
    source === null ||
    typeof source !== 'object' ||
    typeof source['id'] !== 'string' ||
    typeof source['request'] !== 'function' ||
    typeof source['transport'] !== 'object' ||
    typeof source['tiling'] !== 'object' ||
    typeof source['geometricErrorMeters'] !== 'function'
  ) {
    throw new GlobeError('invalid-option', `terrain must be a terrain source, got ${describeInput(terrain)}`);
  }
  const id = source['id'];
  const decoder = source['decoder'] as Partial<Record<string, unknown>> | null | undefined;
  if (typeof decoder !== 'object' || decoder === null || !TERRAIN_DECODERS.includes(decoder['kind'] as string))
    throw new GlobeError('invalid-option', `terrain source ${id}: unknown decoder ${describeInput(decoder)}`);
  if (decoder['kind'] === 'custom' && typeof decoder['decode'] !== 'function')
    throw new GlobeError('invalid-option', `terrain source ${id}: a custom decoder needs a decode function`);
  const datum = source['datum'] as Partial<Record<string, unknown>> | null | undefined;
  const geoid = datum?.['kind'] === 'geoid' && typeof datum['model'] === 'object' && datum['model'] !== null;
  if (typeof datum !== 'object' || datum === null || !(datum['kind'] === 'ellipsoid' || geoid))
    throw new GlobeError('invalid-option', `terrain source ${id}: unknown vertical datum ${describeInput(datum)}`);
  const factory = workers as Partial<Record<string, unknown>> | null | undefined;
  if (typeof factory !== 'object' || factory === null || typeof factory['create'] !== 'function') {
    throw new GlobeError(
      'invalid-option',
      'workers is required when terrain is set: pass createWorkers() from @vibeglobe/worker',
    );
  }
}

/** The view when none is given: the whole globe centered on 0°, 20°N. */
export const DEFAULT_VIEW: ValidView = { longitudeDeg: 0, latitudeDeg: 20, zoom: 1.5, headingDeg: 0, tiltDeg: 0 };

/** Every event `on` accepts. */
const EVENT_NAMES: ReadonlySet<keyof GlobeEvents> = new Set<keyof GlobeEvents>([
  'ready',
  'frame',
  'idle',
  'camera-change',
  'device-lost',
  'device-restored',
  'backend-fallback',
  'tile-error',
  'error',
  'view-mode-change',
  'movestart',
  'move',
  'moveend',
  'tour-waypoint',
]);

/** Throws a typed error unless `event` is a globe event and `handler` a function (KB-038). */
export function validateHandler(event: unknown, handler: unknown): void {
  if (!EVENT_NAMES.has(event as keyof GlobeEvents)) {
    throw new GlobeError('invalid-option', `Unknown event ${describeInput(event)}`);
  }
  // A handler that is not a function would throw on every emit, from inside the frame loop.
  if (typeof handler !== 'function') {
    throw new GlobeError(
      'invalid-option',
      `The handler for ${describeInput(event)} must be a function, got ${describeInput(handler)}`,
    );
  }
}

/** Throws a typed GlobeError naming `name` unless `value` is a finite number. */
function requireFinite(name: string, value: unknown): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new GlobeError('invalid-coordinate', `${name} must be a finite number, got ${describeInput(value)}`);
  }
}

/** Validates a WGS84 position given to a query; throws a typed GlobeError. */
export function validatePosition(position: unknown): void {
  if (position === null || typeof position !== 'object') {
    throw new GlobeError('invalid-coordinate', `A position must be an object, got ${describeInput(position)}`);
  }
  // One check per field, no arrays: elevation queries validate every position and allocate nothing (F144).
  const { longitudeDeg, latitudeDeg, heightMeters } = position as Partial<GeoPosition>;
  requireFinite('longitudeDeg', longitudeDeg);
  requireFinite('latitudeDeg', latitudeDeg);
  requireFinite('heightMeters', heightMeters ?? 0);
  if ((latitudeDeg as number) < -90 || (latitudeDeg as number) > 90) {
    throw new GlobeError(
      'invalid-coordinate',
      `latitudeDeg must be between -90 and 90, got ${describeInput(latitudeDeg)}`,
    );
  }
}

/** Validates a resolution scale given at runtime; throws a typed GlobeError. */
export function validateResolutionScale(scale: unknown): number {
  if (typeof scale !== 'number' || !(scale >= 0.1 && scale <= 4)) {
    throw new GlobeError(
      'invalid-option',
      `resolutionScale must be a number between 0.1 and 4, got ${describeInput(scale)}`,
    );
  }
  return scale;
}

/** Validates a screen point given to a query; throws a typed GlobeError. */
export function validateScreenPoint(point: unknown): ScreenPoint {
  if (!isScreenPoint(point)) {
    throw new GlobeError('invalid-coordinate', `A screen point needs finite xPx and yPx, got ${describeInput(point)}`);
  }
  return point;
}

/** True for an object with finite xPx and yPx. */
export function isScreenPoint(point: unknown): point is ScreenPoint {
  if (point === null || typeof point !== 'object') return false;
  const { xPx, yPx } = point as Partial<ScreenPoint>;
  return typeof xPx === 'number' && Number.isFinite(xPx) && typeof yPx === 'number' && Number.isFinite(yPx);
}

/** A short description of an invalid input for error messages. */
export function describeInput(value: unknown): string {
  // Neither may throw: an object without a prototype has no string conversion, and JSON has no bigint.
  try {
    return typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
