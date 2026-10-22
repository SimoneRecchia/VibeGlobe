import { GlobeError } from '../globe/errors.js';

/** A zoom band over which a curve rises from 0 to 1, in ground zoom (ADR 0008: independent of latitude). */
export interface GroundZoomRange {
  readonly startGroundZoom: number;
  readonly endGroundZoom: number;
}

/**
 * The zoom-driven curves of the Auto view mode (`PLAN.md`, Map experience; ADR 0008, ADR 0015 decision 9): the
 * globe-to-flat morph, the terrain relief and the automatic tilt each rise over their band with an easing that starts
 * and ends with zero slope, so nothing starts or stops abruptly.
 */
export interface ViewCurves {
  /** Globe (0) to flat map (1). */
  readonly morph: GroundZoomRange;
  /** Flat (0) to full terrain relief (1). */
  readonly relief: GroundZoomRange;
  /** 0° to {@link ViewCurves.autoTiltDeg}: only after the map is flat, leaving a 0° 2D band between. */
  readonly tilt: GroundZoomRange;
  /** The tilt Auto reaches at street scale, degrees, 45–60. */
  readonly autoTiltDeg: number;
}

/** Partial curves for the options: every field not given keeps its default. */
export interface ViewCurvesInit {
  readonly morph?: Partial<GroundZoomRange>;
  readonly relief?: Partial<GroundZoomRange>;
  readonly tilt?: Partial<GroundZoomRange>;
  readonly autoTiltDeg?: number;
}

/**
 * ADR 0008's starting values in the MapLibre zoom convention: the map flattens at country scale (ground zoom 4 to 6.5),
 * relief rises from region to street scale (10 to 15), and the tilt only at neighborhood scale (14 to 16.5).
 */
export const DEFAULT_VIEW_CURVES: ViewCurves = Object.freeze({
  morph: Object.freeze({ startGroundZoom: 4, endGroundZoom: 6.5 }),
  relief: Object.freeze({ startGroundZoom: 10, endGroundZoom: 15 }),
  tilt: Object.freeze({ startGroundZoom: 14, endGroundZoom: 16.5 }),
  autoTiltDeg: 50,
});

/** Lowest and highest automatic tilt, degrees (`PLAN.md`: 45–60°). */
export const AUTO_TILT_RANGE_DEG = Object.freeze([45, 60] as const);

function range(name: string, given: Partial<GroundZoomRange> | undefined, fallback: GroundZoomRange): GroundZoomRange {
  const startGroundZoom = given?.startGroundZoom ?? fallback.startGroundZoom;
  const endGroundZoom = given?.endGroundZoom ?? fallback.endGroundZoom;
  if (!Number.isFinite(startGroundZoom) || !Number.isFinite(endGroundZoom) || startGroundZoom >= endGroundZoom)
    throw new GlobeError(
      'invalid-option',
      `viewCurves.${name}: startGroundZoom must be a finite number below endGroundZoom (got ${String(startGroundZoom)} and ${String(endGroundZoom)})`,
    );
  return Object.freeze({ startGroundZoom, endGroundZoom });
}

/**
 * Validates curve options (F150) and fills the missing fields from {@link DEFAULT_VIEW_CURVES}. Each band must be
 * ordered, the automatic tilt within 45–60°, and the tilt may start only once the map is flat (the morph's band ends
 * at or before the tilt's starts), so the 2D band stays at 0°.
 */
export function validateViewCurves(init: ViewCurvesInit | undefined): ViewCurves {
  if (init === undefined) return DEFAULT_VIEW_CURVES;
  if (typeof init !== 'object' || init === null) throw new GlobeError('invalid-option', 'viewCurves must be an object');
  const morph = range('morph', init.morph, DEFAULT_VIEW_CURVES.morph);
  const relief = range('relief', init.relief, DEFAULT_VIEW_CURVES.relief);
  const tilt = range('tilt', init.tilt, DEFAULT_VIEW_CURVES.tilt);
  const autoTiltDeg = init.autoTiltDeg ?? DEFAULT_VIEW_CURVES.autoTiltDeg;
  if (!(autoTiltDeg >= AUTO_TILT_RANGE_DEG[0] && autoTiltDeg <= AUTO_TILT_RANGE_DEG[1]))
    throw new GlobeError('invalid-option', `viewCurves.autoTiltDeg must be within 45–60° (got ${String(autoTiltDeg)})`);
  if (tilt.startGroundZoom < morph.endGroundZoom)
    throw new GlobeError(
      'invalid-option',
      `viewCurves: the tilt band (from ${String(tilt.startGroundZoom)}) must start after the morph band ends (${String(morph.endGroundZoom)})`,
    );
  return Object.freeze({ morph, relief, tilt, autoTiltDeg });
}

/**
 * Perlin's smootherstep: 0 below `start`, 1 above `end`, 6t⁵ − 15t⁴ + 10t³ between, with zero first and second
 * derivatives at both ends. Bounds and value are read from `io[0..2]` and the result written to `io[3]`, so per-frame
 * callers pass no double as an argument (ADR 0018).
 */
export function smootherstepInto(io: Float64Array): void {
  const start = io[0] ?? 0;
  const end = io[1] ?? 1;
  const x = io[2] ?? 0;
  const t = x <= start ? 0 : x >= end ? 1 : (x - start) / (end - start);
  io[3] = t * t * t * (t * (t * 6 - 15) + 10);
}

const step = new Float64Array(4);

/** Writes `band`'s eased value at ground zoom `at[0]` into `out[index]`. */
function ease(band: GroundZoomRange, at: Float64Array, out: Float64Array, index: number): void {
  step[0] = band.startGroundZoom;
  step[1] = band.endGroundZoom;
  step[2] = at[0] ?? 0;
  smootherstepInto(step);
  out[index] = step[3] ?? 0;
}

/** Index of the morph factor in the output of {@link evaluateViewCurves}. */
export const CURVE_MORPH = 0;
/** Index of the relief factor in the output of {@link evaluateViewCurves}. */
export const CURVE_RELIEF = 1;
/** Index of the automatic tilt, radians, in the output of {@link evaluateViewCurves}. */
export const CURVE_TILT_RAD = 2;

/**
 * The Auto mode's state at ground zoom `groundZoom[0]` (F548): the morph factor, the relief factor and the automatic
 * tilt in radians, written to `out` at {@link CURVE_MORPH}, {@link CURVE_RELIEF} and {@link CURVE_TILT_RAD}. Every
 * value is a continuous function of zoom with zero slope at the ends of its band. Allocates nothing.
 */
export function evaluateViewCurves(curves: ViewCurves, groundZoom: Float64Array, out: Float64Array): void {
  ease(curves.morph, groundZoom, out, CURVE_MORPH);
  ease(curves.relief, groundZoom, out, CURVE_RELIEF);
  ease(curves.tilt, groundZoom, out, CURVE_TILT_RAD);
  out[CURVE_TILT_RAD] = (out[CURVE_TILT_RAD] ?? 0) * ((curves.autoTiltDeg * Math.PI) / 180);
}
