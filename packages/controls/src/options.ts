import { GlobeError } from '@vibeglobe/core';

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

/** Inertia time constants (ADR 0009 §6): the remaining motion decays as e^(−t/τ). */
export interface InertiaSettings {
  readonly panTauMs: number;
  readonly rotateTauMs: number;
  readonly tiltTauMs: number;
  readonly zoomTauMs: number;
  /** The fastest pan a release carries on, in CSS pixels per second. */
  readonly maxPanSpeedPxPerS: number;
  /** Velocity is measured over this much time before the release. */
  readonly velocityWindowMs: number;
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
}

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
    panTauMs: 200,
    rotateTauMs: 200,
    tiltTauMs: 150,
    zoomTauMs: 150,
    maxPanSpeedPxPerS: 2500,
    velocityWindowMs: 80,
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
    inertia: numbers('inertia', d.inertia, options.inertia, ['panTauMs', 'rotateTauMs', 'tiltTauMs', 'zoomTauMs']),
    wheel: numbers('wheel', d.wheel, options.wheel, ['pixelsPerLevel', 'pinchPixelsPerLevel', 'maxLeadLevels']),
    keyboard: numbers('keyboard', d.keyboard, options.keyboard, ['smoothingMs', 'zoomLevelsPerPress']),
    touch: numbers('touch', d.touch, options.touch, ['tapMaxMs', 'doubleTapMs', 'tiltDecisionMs']),
    rotateDegPerViewportWidth: scalar('rotateDegPerViewportWidth', options.rotateDegPerViewportWidth, 180, 0, 3600),
    tiltDegPerViewportHeight: scalar('tiltDegPerViewportHeight', options.tiltDegPerViewportHeight, 90, 0, 3600),
    maxTiltDeg: scalar('maxTiltDeg', options.maxTiltDeg, d.maxTiltDeg, 0, 89),
    zoomAnimationMs: scalar('zoomAnimationMs', options.zoomAnimationMs, d.zoomAnimationMs, 1, 10_000),
    reducedMotion,
  };
}
