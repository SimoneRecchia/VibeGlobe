import { GlobeError } from './errors.js';
import type { GlobeOptions, ViewInit } from './types.js';

const MAX_ZOOM = 24;

function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new GlobeError('invalid-coordinate', `${name} must be a finite number, got ${String(value)}`);
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
    throw new GlobeError('invalid-coordinate', `A view must be an object, got ${String(view)}`);
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
    throw new GlobeError('invalid-option', `createGlobe options must be an object, got ${String(options)}`);
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
  ] as const) {
    const value = input[name];
    if (value !== undefined) {
      const number = typeof value === 'number' ? value : NaN;
      if (!(number >= min && number <= max)) {
        throw new GlobeError(
          'invalid-option',
          `${name} must be a number between ${min} and ${max}, got ${String(value)}`,
        );
      }
    }
  }
  if (input.view !== undefined) validateView(input.view, DEFAULT_VIEW);
  return options as GlobeOptions;
}

/** The view when none is given: the whole globe centered on 0°, 20°N. */
export const DEFAULT_VIEW: ValidView = { longitudeDeg: 0, latitudeDeg: 20, zoom: 1.5, headingDeg: 0, tiltDeg: 0 };
