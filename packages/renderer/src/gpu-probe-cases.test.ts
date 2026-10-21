import { describe, expect, it } from 'vitest';
import { splitEyeOffset } from './eye-offset.js';
import {
  cameraFrame,
  depthDistances,
  exactClip,
  lowPartCase,
  precisionCases,
  projectionMatrix,
  random,
  screenDistancePx,
  viewMatrix,
  type PrecisionCase,
} from './gpu-probe-cases.js';

/** Where the shader puts the vertex: (offset + T_hi) + T_lo in float32, or without T_lo. */
function shaderClip(c: PrecisionCase, view: Float64Array, projection: Float64Array, dropLow: boolean): Float64Array {
  const high = new Float32Array(3);
  const low = new Float32Array(3);
  splitEyeOffset(c.origin, c.eye, high, low);
  const relative = Float64Array.from(high, (h, i) => {
    const sum = Math.fround((c.offset[i] ?? 0) + h);
    return dropLow ? sum : Math.fround(sum + (low[i] ?? 0));
  });
  return exactClip(view, projection, { origin: relative, offset: new Float32Array(3), eye: new Float64Array(3) });
}

describe('GPU probe cases (ADR 0004)', () => {
  const fixed = lowPartCase();
  const toVertex = fixed.origin.map((o, i) => o + (fixed.offset[i] ?? 0) - (fixed.eye[i] ?? 0));
  const length = Math.hypot(...toVertex);
  const frame = cameraFrame(
    toVertex.map((c) => c / length),
    random(7),
  );
  const view = viewMatrix(frame);
  const projection = projectionMatrix();

  it('puts every case in view and within 0.01 px when emulated in float32', () => {
    const cases = [fixed, ...precisionCases(frame, 255, random(1))];
    for (const c of cases) {
      const exact = exactClip(view, projection, c);
      expect(exact[2]).toBeGreaterThan(0);
      expect(Math.abs((exact[0] ?? 0) / (exact[2] ?? 1))).toBeLessThan(1);
      expect(Math.abs((exact[1] ?? 0) / (exact[2] ?? 1))).toBeLessThan(1);
      expect(screenDistancePx(shaderClip(c, view, projection, false), exact)).toBeLessThan(0.01);
      expect(screenDistancePx(shaderClip(c, view, projection, true), exact)).toBeLessThan(0.4);
    }
  });

  it('has a fixed case that a lost T_lo moves by more than 0.1 px (KB-025)', () => {
    const exact = exactClip(view, projection, fixed);
    expect(screenDistancePx(shaderClip(fixed, view, projection, true), exact)).toBeGreaterThan(0.1);
  });

  it('spreads the depth probe over the whole depth range', () => {
    const distances = depthDistances(64);
    expect(distances[0]).toBeCloseTo(0.12);
    expect(distances[63]).toBeCloseTo(4e7, -1);
  });
});
