// Placement of a tileset in a frame (F464, F465): exact on the globe, rigid through the morph, and the inverse used
// by traversal and picking.
import { geodeticToEcef, MorphFrame, type FrameView } from '@vibeglobe/core';
import { describe, expect, it } from 'vitest';
import {
  contentToWorld,
  createViewFrame,
  screenRay,
  TilesetAnchor,
  traversalCamera,
  viewFrame,
  worldToEcef,
} from './view-frame.js';

const RAD = Math.PI / 180;
const ecef = (lonDeg: number, latDeg: number, h: number): number[] => {
  const out = new Float64Array(3);
  geodeticToEcef(lonDeg * RAD, latDeg * RAD, h, out);
  return [...out];
};

function frameView(eye: number[], morph = new MorphFrame()): FrameView {
  // Looking along −Z of an arbitrary rotation (identity), 90° vertical field, square viewport.
  const view = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const projection = new Float64Array(16);
  projection[0] = 1;
  projection[5] = 1;
  projection[11] = -1;
  projection[14] = 0.1;
  return { morph, view, projection, eyeEcef: Float64Array.from(eye), widthPx: 200, heightPx: 200, pixelRatio: 1 };
}

describe('view frame (F464, F465)', () => {
  const center = ecef(12.4922, 41.8902, 0);
  const anchor = new TilesetAnchor(center);

  it('is ECEF minus the eye on the globe, in float64, so a point 2 m from the eye stays exact', () => {
    const eye = ecef(12.4922, 41.8902, 2);
    const frame = viewFrame(frameView(eye), anchor, createViewFrame());
    const point = ecef(12.49221, 41.89021, 0.5);
    const tile = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, point[0] ?? 0, point[1] ?? 0, point[2] ?? 0, 1];
    const m = contentToWorld(frame, tile, new Float64Array(16));
    for (let i = 0; i < 3; i++)
      expect(Math.abs((m[12 + i] ?? 0) - ((point[i] ?? 0) - (eye[i] ?? 0)))).toBeLessThan(1e-6);
    expect(worldToEcef(frame, [m[12] ?? 0, m[13] ?? 0, m[14] ?? 0]).map((c, i) => c - (point[i] ?? 0))).toEqual([
      expect.closeTo(0, 6),
      expect.closeTo(0, 6),
      expect.closeTo(0, 6),
    ]);
  });

  it('carries the tileset rigidly on the flat map: distances between its points are kept', () => {
    const morph = new MorphFrame();
    morph.update(Float64Array.of(12.4922 * RAD, 41.8902 * RAD), Float64Array.of(1, 1));
    const frame = viewFrame(frameView([0, 0, 0], morph), anchor, createViewFrame());
    const a = ecef(12.49, 41.889, 0);
    const b = ecef(12.495, 41.892, 50);
    const toWorld = (p: number[]): number[] => {
      const m = contentToWorld(
        frame,
        [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, 1],
        new Float64Array(16),
      );
      return [m[12] ?? 0, m[13] ?? 0, m[14] ?? 0];
    };
    const d = (p: number[], q: number[]): number => Math.hypot(...p.map((c, i) => c - (q[i] ?? 0)));
    expect(d(toWorld(a), toWorld(b))).toBeCloseTo(d(a, b), 6);
    expect(worldToEcef(frame, toWorld(b))[2]).toBeCloseTo(b[2] ?? 0, 4);
  });

  it('gives traversal the eye in ECEF, the view direction, the field of view and planes that contain the view', () => {
    const eye = ecef(12.4922, 41.8902, 100);
    const camera = traversalCamera(frameView(eye), viewFrame(frameView(eye), anchor, createViewFrame()));
    camera.position.forEach((c, i) => expect(c).toBeCloseTo(eye[i] ?? 0, 6));
    expect(camera.direction).toEqual([expect.closeTo(0, 9), expect.closeTo(0, 9), expect.closeTo(-1, 9)]);
    expect(camera.fovYRad).toBeCloseTo(Math.PI / 2, 9);
    const ahead = [eye[0] ?? 0, eye[1] ?? 0, (eye[2] ?? 0) - 10];
    for (const [nx, ny, nz, w] of camera.planes ?? [])
      expect(nx * (ahead[0] ?? 0) + ny * (ahead[1] ?? 0) + nz * (ahead[2] ?? 0) + w).toBeGreaterThan(0);
    expect(camera.planes).toHaveLength(4);
  });

  it('casts the ray of a canvas point through the projection: the corner ray of a 90° view leaves at 45°', () => {
    const ray = screenRay(frameView([0, 0, 0]), 200, 100);
    expect(ray.direction[0]).toBeCloseTo(Math.SQRT1_2, 9);
    expect(ray.direction[2]).toBeCloseTo(-Math.SQRT1_2, 9);
  });
});
