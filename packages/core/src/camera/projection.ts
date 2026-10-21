import type { Camera } from './camera.js';

/**
 * Projects the ECEF point `ecef[0..2]` to CSS pixels for a camera, writing x and y to `out`. Returns false (leaving
 * `out` unchanged) when the point is behind the eye. The point comes in an array because the drag solver projects every
 * frame and V8 boxes doubles passed as arguments (ADR 0018).
 */
export function projectToScreen(camera: Camera, ecef: Float64Array, out: Float64Array): boolean {
  const eye = camera.eyeEcef;
  const vx = (ecef[0] ?? 0) - (eye[0] ?? 0);
  const vy = (ecef[1] ?? 0) - (eye[1] ?? 0);
  const vz = (ecef[2] ?? 0) - (eye[2] ?? 0);
  const depth = vx * (camera.forward[0] ?? 0) + vy * (camera.forward[1] ?? 0) + vz * (camera.forward[2] ?? 0);
  if (depth <= 0) return false;
  const tanV = Math.tan(camera.fovYRad / 2);
  const tanH = tanV * (camera.widthPx / camera.heightPx);
  const right = vx * (camera.right[0] ?? 0) + vy * (camera.right[1] ?? 0) + vz * (camera.right[2] ?? 0);
  const up = vx * (camera.up[0] ?? 0) + vy * (camera.up[1] ?? 0) + vz * (camera.up[2] ?? 0);
  out[0] = ((right / depth / tanH + 1) / 2) * camera.widthPx;
  out[1] = ((1 - up / depth / tanV) / 2) * camera.heightPx;
  return true;
}
