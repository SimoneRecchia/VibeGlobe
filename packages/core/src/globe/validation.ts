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
  for (const [name, min, max] of [
    ['resolutionScale', 0.1, 4],
    ['maxScreenErrorPx', 0.1, 64],
    ['manualClockStepMs', 0.001, 1000],
  ] as const) {
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
  return options as GlobeOptions;
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
  'error',
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

/** Validates a WGS84 position given to a query; throws a typed GlobeError. */
export function validatePosition(position: unknown): void {
  if (position === null || typeof position !== 'object') {
    throw new GlobeError('invalid-coordinate', `A position must be an object, got ${describeInput(position)}`);
  }
  const { longitudeDeg, latitudeDeg, heightMeters } = position as Partial<GeoPosition>;
  for (const [name, value] of [
    ['longitudeDeg', longitudeDeg],
    ['latitudeDeg', latitudeDeg],
    ['heightMeters', heightMeters ?? 0],
  ] as const) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new GlobeError('invalid-coordinate', `${name} must be a finite number, got ${describeInput(value)}`);
    }
  }
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
