// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { GlobeError, type NavigationMode } from '@vibeglobe/core';

/** Which gestures are on; every one is on by default. */
export interface GestureSwitches {
  /** Primary-button or one-finger drag pans. */
  readonly dragPan: boolean;
  /** Wheel, trackpad scroll and trackpad pinch zoom. */
  readonly wheelZoom: boolean;
  /** Double-click and double-tap zoom in one level. */
  readonly doubleClickZoom: boolean;
  /** Shift+drag draws a zoom box. */
  readonly boxZoom: boolean;
  /** Right-drag and Ctrl+drag rotate and tilt. */
  readonly dragRotate: boolean;
  /** Pinch zoom and the two-finger tap. */
  readonly touchZoom: boolean;
  /** Two-finger twist rotates. */
  readonly touchRotate: boolean;
  /** Two-finger vertical drag tilts. */
  readonly touchTilt: boolean;
  /** Arrow keys, Shift+arrows, +/- and the other keys of the key map. */
  readonly keyboard: boolean;
  /** Motion continues after a drag, pinch or twist is released with velocity. */
  readonly inertia: boolean;
}

/**
 * The tilt policy (F625): far from the ground the view stays flat and cannot tilt; close to it the tilt rises by itself.
 * Distances are from the eye to the point looked at, which is the height above the ground when looking straight down.
 */
export interface TiltPolicy {
  /** Beyond this distance the tilt is 0° and neither gestures nor the API can tilt, meters (default 20,000). */
  readonly lock2DAboveMeters: number;
  /** Within this distance the automatic tilt rises from 0°, meters (default 2,000), below the lock. */
  readonly autoTiltBelowMeters: number;
  /** The automatic tilt reached at a quarter of `autoTiltBelowMeters`, degrees (default 60), at most `maxTiltDeg`. */
  readonly autoTiltMaxDeg: number;
  /**
   * Within this distance the policy no longer caps the tilt, meters (default half the lock), below the lock: from the
   * lock to here the largest tilt rises continuously from 0° to 90° (F641), so a far start of this range lets the
   * view tilt more and more while zooming in. The camera's `maxTiltDeg` reports the cap with the engine's own limits.
   */
  readonly fullTiltBelowMeters: number;
}

/** Inertia time constants (ADR 0009 §6): the remaining motion decays as e^(−t/τ). */
export interface InertiaSettings {
  /** Pan glide after a drag; 650 ms keeps a fifth of the release speed after 1 s (KB-177). */
  readonly panTauMs: number;
  /** Rotation glide after a rotate drag (Ctrl or right button); 650 ms by default, like the pan (KB-177). */
  readonly rotateTauMs: number;
  /** Heading glide after a two-finger twist: short, so a twist ends close to where the fingers left it (KB-177). */
  readonly twistTauMs: number;
  readonly tiltTauMs: number;
  readonly zoomTauMs: number;
  /** The fastest pan a release carries on, in CSS pixels per second. */
  readonly maxPanSpeedPxPerS: number;
  /**
   * Velocity is the least-squares slope of the motion over this much time before the latest move (stretched when
   * events come slower), however long before the release that move came (KB-177).
   */
  readonly velocityWindowMs: number;
  /** A release after the pointer stayed within {@link stillPx} for at least this long does not glide (KB-177). */
  readonly stillMs: number;
  /** Motion within this distance, in CSS pixels, counts as holding still (sensor jitter). */
  readonly stillPx: number;
}

/** Wheel and trackpad zoom (ADR 0009 §4). */
export interface WheelSettings {
  /** Wheel pixels per zoom level. */
  readonly pixelsPerLevel: number;
  /** Trackpad pinch (wheel events with `ctrlKey` and no Ctrl key held) pixels per level. */
  readonly pinchPixelsPerLevel: number;
  /** Smoothing of notch-like events (line or page mode, or whole deltas of 50 px or more). */
  readonly notchSmoothingMs: number;
  /** How far the smoothed zoom may lead the camera, in levels. */
  readonly maxLeadLevels: number;
}

/** Keyboard speeds; held keys approach them with exponential smoothing (ADR 0009 §4). */
export interface KeyboardSettings {
  /** Arrow-key pan speed, in viewport heights per second. */
  readonly panViewportsPerS: number;
  readonly rotateDegPerS: number;
  readonly tiltDegPerS: number;
  /** Time constant of the eased start and stop. */
  readonly smoothingMs: number;
  /** Zoom levels per +/- press (the zoom commands use the same step). */
  readonly zoomLevelsPerPress: number;
}

/** Touch recognition thresholds (ADR 0009 §4). */
export interface TouchSettings {
  /** A tap moves at most this far and lasts at most `tapMaxMs`. */
  readonly tapMaxMovePx: number;
  readonly tapMaxMs: number;
  /** A second tap or click within this time and distance of the first makes a double tap. */
  readonly doubleTapMs: number;
  readonly doubleTapMaxPx: number;
  /** Two side-by-side fingers that both move this far vertically in the same direction start a tilt... */
  readonly tiltStartPx: number;
  /** ...within this time of the second finger's arrival; otherwise pan, pinch and twist combine. */
  readonly tiltDecisionMs: number;
  /** A pinch starts zooming once the finger distance changes by this many zoom levels. */
  readonly pinchThresholdLevels: number;
  /** A twist starts rotating once the fingers travel this far along their circle. */
  readonly rotateThresholdPx: number;
}

/** Options of {@link createControls}; every field is optional. */
export interface ControlsOptions {
  readonly gestures?: Partial<GestureSwitches>;
  readonly inertia?: Partial<InertiaSettings>;
  readonly wheel?: Partial<WheelSettings>;
  readonly keyboard?: Partial<KeyboardSettings>;
  readonly touch?: Partial<TouchSettings>;
  /** Heading change of a rotate drag across the whole viewport width (default 180°). */
  readonly rotateDegPerViewportWidth?: number;
  /** Tilt change of a tilt drag across the whole viewport height (default 90°). */
  readonly tiltDegPerViewportHeight?: number;
  /** The largest tilt input asks for (default 89°, the engine's limit); the engine may clamp it further. */
  readonly maxTiltDeg?: number;
  /** Duration of the zoom commands, double-click and zoom-box animations (time constant, default 120 ms). */
  readonly zoomAnimationMs?: number;
  /**
   * Reduced motion: 'system' (default) follows `prefers-reduced-motion` at runtime; 'reduce' always shortens inertia to a
   * quarter of its time constants; 'no-preference' never does.
   */
  readonly reducedMotion?: 'system' | 'reduce' | 'no-preference';
  /**
   * How a drag moves the camera: 'free' (default) turns the globe as a trackball, so the grabbed point stays under the
   * cursor, the view passes over the poles and the heading turns with it; 'north-up' keeps north up, horizontal drags
   * turning about the polar axis and vertical ones changing latitude, and stops at the poles. Changed at runtime with
   * `setNavigationMode`.
   */
  readonly navigationMode?: NavigationMode;
  /**
   * 'north-up' only: the highest latitude of the point the camera looks at, degrees, from 1 to 89.9 (default 85).
   * Drags and zooms stop there, short of the pole, where turning about the polar axis would spin the view. Changed at
   * runtime with `setNorthUpMaxLatitude`.
   */
  readonly northUpMaxLatitudeDeg?: number;
  /**
   * The tilt policy (F625): `true` for the defaults (20,000 m, 2,000 m, 60°, 10,000 m), an object for some of them, omitted or
   * `false` for none (the engine's zoom curves tilt the view). Changed at runtime with `setTiltPolicy`.
   */
  readonly tiltPolicy?: boolean | Partial<TiltPolicy>;
}

/** Options with every default filled in. */
export interface ResolvedControlsOptions {
  readonly gestures: GestureSwitches;
  readonly inertia: InertiaSettings;
  readonly wheel: WheelSettings;
  readonly keyboard: KeyboardSettings;
  readonly touch: TouchSettings;
  readonly rotateDegPerViewportWidth: number;
  readonly tiltDegPerViewportHeight: number;
  readonly maxTiltDeg: number;
  readonly zoomAnimationMs: number;
  readonly reducedMotion: 'system' | 'reduce' | 'no-preference';
  readonly navigationMode: NavigationMode;
  readonly northUpMaxLatitudeDeg: number;
  /** The tilt policy in force at start, or null for none. */
  readonly tiltPolicy: TiltPolicy | null;
}

/** The tilt policy's defaults (F625). */
export const DEFAULT_TILT_POLICY: TiltPolicy = Object.freeze({
  lock2DAboveMeters: 20_000,
  autoTiltBelowMeters: 2_000,
  autoTiltMaxDeg: 60,
  fullTiltBelowMeters: 10_000,
});

/** The defaults: ADR 0009's starting values. */
export const DEFAULT_CONTROLS_OPTIONS: ResolvedControlsOptions = {
  gestures: {
    dragPan: true,
    wheelZoom: true,
    doubleClickZoom: true,
    boxZoom: true,
    dragRotate: true,
    touchZoom: true,
    touchRotate: true,
    touchTilt: true,
    keyboard: true,
    inertia: true,
  },
  inertia: {
    panTauMs: 650,
    rotateTauMs: 650,
    twistTauMs: 200,
    tiltTauMs: 150,
    zoomTauMs: 150,
    maxPanSpeedPxPerS: 2500,
    velocityWindowMs: 50,
    stillMs: 150,
    stillPx: 2,
  },
  wheel: { pixelsPerLevel: 300, pinchPixelsPerLevel: 100, notchSmoothingMs: 100, maxLeadLevels: 2 },
  keyboard: { panViewportsPerS: 0.8, rotateDegPerS: 90, tiltDegPerS: 45, smoothingMs: 150, zoomLevelsPerPress: 1 },
  touch: {
    tapMaxMovePx: 10,
    tapMaxMs: 250,
    doubleTapMs: 300,
    doubleTapMaxPx: 20,
    tiltStartPx: 3,
    tiltDecisionMs: 100,
    pinchThresholdLevels: 0.1,
    rotateThresholdPx: 25,
  },
  rotateDegPerViewportWidth: 180,
  tiltDegPerViewportHeight: 90,
  maxTiltDeg: 89,
  zoomAnimationMs: 120,
  reducedMotion: 'system',
  navigationMode: 'free',
  northUpMaxLatitudeDeg: 85,
  tiltPolicy: null,
};

function invalid(name: string, rule: string): GlobeError {
  return new GlobeError('invalid-option', `Controls option ${name} must be ${rule}`);
}

/** Merges one group of numeric settings over its defaults, each a finite number ≥ 0 (> 0 where `positive`). */
function numbers<T extends object>(group: string, defaults: T, input: Partial<T> | undefined, positive: string[]): T {
  if (input === undefined) return defaults;
  if (input === null || typeof input !== 'object') throw invalid(group, 'an object');
  const out: Record<string, number> = { ...(defaults as Record<string, number>) };
  for (const [key, value] of Object.entries(input)) {
    if (!(key in defaults)) throw invalid(`${group}.${key}`, 'a known setting');
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw invalid(`${group}.${key}`, 'a finite number ≥ 0');
    }
    if (value === 0 && positive.includes(key)) throw invalid(`${group}.${key}`, 'greater than 0');
    out[key] = value;
  }
  return out as T;
}

function switches(input: Partial<GestureSwitches> | undefined): GestureSwitches {
  const defaults = DEFAULT_CONTROLS_OPTIONS.gestures;
  if (input === undefined) return defaults;
  if (input === null || typeof input !== 'object') throw invalid('gestures', 'an object');
  for (const [key, value] of Object.entries(input)) {
    if (!(key in defaults)) throw invalid(`gestures.${key}`, 'a known gesture');
    if (typeof value !== 'boolean') throw invalid(`gestures.${key}`, 'a boolean');
  }
  return { ...defaults, ...input };
}

function scalar(name: string, value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw invalid(name, `a number from ${min} to ${max}`);
  }
  return value;
}

/** Validates options and fills in the defaults; invalid input throws a GlobeError ('invalid-option'). */
export function resolveControlsOptions(options: ControlsOptions = {}): ResolvedControlsOptions {
  if (options === null || typeof options !== 'object') throw invalid('options', 'an object');
  const d = DEFAULT_CONTROLS_OPTIONS;
  const reducedMotion = options.reducedMotion ?? d.reducedMotion;
  if (!['system', 'reduce', 'no-preference'].includes(reducedMotion)) {
    throw invalid('reducedMotion', "'system', 'reduce' or 'no-preference'");
  }
  return {
    gestures: switches(options.gestures),
    inertia: numbers('inertia', d.inertia, options.inertia, [
      'panTauMs',
      'rotateTauMs',
      'twistTauMs',
      'tiltTauMs',
      'zoomTauMs',
    ]),
    wheel: numbers('wheel', d.wheel, options.wheel, ['pixelsPerLevel', 'pinchPixelsPerLevel', 'maxLeadLevels']),
    keyboard: numbers('keyboard', d.keyboard, options.keyboard, ['smoothingMs', 'zoomLevelsPerPress']),
    touch: numbers('touch', d.touch, options.touch, ['tapMaxMs', 'doubleTapMs', 'tiltDecisionMs']),
    rotateDegPerViewportWidth: scalar('rotateDegPerViewportWidth', options.rotateDegPerViewportWidth, 180, 0, 3600),
    tiltDegPerViewportHeight: scalar('tiltDegPerViewportHeight', options.tiltDegPerViewportHeight, 90, 0, 3600),
    maxTiltDeg: scalar('maxTiltDeg', options.maxTiltDeg, d.maxTiltDeg, 0, 89),
    zoomAnimationMs: scalar('zoomAnimationMs', options.zoomAnimationMs, d.zoomAnimationMs, 1, 10_000),
    reducedMotion,
    navigationMode: validNavigationMode(options.navigationMode ?? d.navigationMode),
    northUpMaxLatitudeDeg: validNorthUpLatitude(options.northUpMaxLatitudeDeg ?? d.northUpMaxLatitudeDeg),
    tiltPolicy: validTiltPolicy(options.tiltPolicy ?? false, scalar('maxTiltDeg', options.maxTiltDeg, 89, 0, 89)),
  };
}

/** A 'north-up' latitude limit, degrees from 1 to 89.9, or a GlobeError ('invalid-option') for anything else. */
export function validNorthUpLatitude(deg: unknown): number {
  return scalar('northUpMaxLatitudeDeg', deg as number, 85, 1, 89.9);
}

/** A navigation mode, or a GlobeError ('invalid-option') for anything else. */
export function validNavigationMode(mode: unknown): NavigationMode {
  if (mode !== 'free' && mode !== 'north-up') throw invalid('navigationMode', "'free' or 'north-up'");
  return mode;
}

/**
 * A tilt policy with its defaults filled in (`true` for all of them), null for `false` or `null`, or a GlobeError
 * ('invalid-option'): the lock from 1 m to 40,000 km, the automatic tilt's distance below it, its tilt from 1° to
 * `maxTiltDeg`, and the distance where the cap ends below the lock (half of it when omitted).
 */
export function validTiltPolicy(policy: unknown, maxTiltDeg = 89): TiltPolicy | null {
  if (policy === false || policy === null) return null;
  if (policy === true) return DEFAULT_TILT_POLICY;
  if (typeof policy !== 'object') throw invalid('tiltPolicy', 'a boolean or an object');
  const input = policy as Partial<TiltPolicy>;
  const d = DEFAULT_TILT_POLICY;
  const lock = scalar('tiltPolicy.lock2DAboveMeters', input.lock2DAboveMeters, d.lock2DAboveMeters, 1, 4e7);
  const below = scalar('tiltPolicy.autoTiltBelowMeters', input.autoTiltBelowMeters, d.autoTiltBelowMeters, 0, lock);
  if (below <= 0 || below >= lock) throw invalid('tiltPolicy.autoTiltBelowMeters', 'above 0 and below the lock');
  const tilt = scalar('tiltPolicy.autoTiltMaxDeg', input.autoTiltMaxDeg, d.autoTiltMaxDeg, 1, maxTiltDeg);
  const full = scalar('tiltPolicy.fullTiltBelowMeters', input.fullTiltBelowMeters, lock / 2, 0, lock);
  if (full <= 0 || full >= lock) throw invalid('tiltPolicy.fullTiltBelowMeters', 'above 0 and below the lock');
  return Object.freeze({
    lock2DAboveMeters: lock,
    autoTiltBelowMeters: below,
    autoTiltMaxDeg: tilt,
    fullTiltBelowMeters: full,
  });
}
