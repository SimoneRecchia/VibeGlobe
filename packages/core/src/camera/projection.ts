import type { Camera } from './camera.js';

/**
 * Projects an ECEF point to CSS pixels for a camera, writing x and y to `out`. Returns false (leaving `out` unchanged)
 * when the point is behind the eye.
 */
export function projectToScreen(camera: Camera, x: number, y: number, z: number, out: Float64Array): boolean {
  const eye = camera.eyeEcef;
  const vx = x - (eye[0] ?? 0);
  const vy = y - (eye[1] ?? 0);
  const vz = z - (eye[2] ?? 0);
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
