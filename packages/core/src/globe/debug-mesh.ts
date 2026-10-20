import { geodeticToEcef } from '../geodesy/ecef.js';
import { GlobeError } from './errors.js';
import type { DebugMeshData, DebugShape } from './types.js';

const RAD = Math.PI / 180;
const corner = new Float64Array(3);

/** Converts a debug quad to renderer data: corners as float32 offsets from their float64 centroid (ADR 0004). */
export function buildDebugMesh(shape: DebugShape): DebugMeshData {
  const ecef: number[] = [];
  for (const position of shape.corners) {
    const values = [position.longitudeDeg, position.latitudeDeg, position.heightMeters ?? 0];
    if (!values.every(Number.isFinite) || Math.abs(position.latitudeDeg) > 90) {
      throw new GlobeError('invalid-coordinate', `Debug shape corner out of range: ${JSON.stringify(position)}`);
    }
    geodeticToEcef(position.longitudeDeg * RAD, position.latitudeDeg * RAD, position.heightMeters ?? 0, corner);
    ecef.push(corner[0] ?? 0, corner[1] ?? 0, corner[2] ?? 0);
  }
  const originEcef = new Float64Array(3);
  for (let axis = 0; axis < 3; axis++)
    originEcef[axis] = ((ecef[axis] ?? 0) + (ecef[axis + 3] ?? 0) + (ecef[axis + 6] ?? 0) + (ecef[axis + 9] ?? 0)) / 4;
  const positions = new Float32Array(12);
  for (let i = 0; i < 12; i++) positions[i] = (ecef[i] ?? 0) - (originEcef[i % 3] ?? 0);
  return { originEcef, positions, colorRgb: shape.colorRgb, checkerMeters: shape.checkerMeters ?? 0 };
}
