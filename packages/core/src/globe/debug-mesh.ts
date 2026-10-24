// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { geodeticToEcef } from '../geodesy/ecef.js';
import { GlobeError } from './errors.js';
import { describeInput } from './validation.js';
import type { DebugMeshData, DebugShape } from './types.js';

const RAD = Math.PI / 180;
const corner = new Float64Array(3);

/** Throws a typed error unless `shapes` is a list of debug quads (F050, KB-038); corners are checked when built. */
function validateDebugShapes(shapes: unknown): asserts shapes is readonly DebugShape[] {
  if (!Array.isArray(shapes)) throw new GlobeError('invalid-option', 'setDebugShapes needs an array of shapes');
  for (const shape of shapes as unknown[]) {
    const { corners, colorRgb, checkerMeters } = (shape ?? {}) as Partial<Record<keyof DebugShape, unknown>>;
    if (shape === null || typeof shape !== 'object') {
      throw new GlobeError('invalid-option', `A debug shape must be an object, got ${describeInput(shape)}`);
    }
    if (!Array.isArray(corners) || corners.length !== 4 || corners.some((c) => c === null || typeof c !== 'object')) {
      throw new GlobeError('invalid-option', 'A debug shape needs four corner positions');
    }
    if (
      !Array.isArray(colorRgb) ||
      colorRgb.length !== 3 ||
      !colorRgb.every((c) => typeof c === 'number' && c >= 0 && c <= 1)
    ) {
      throw new GlobeError('invalid-option', 'A debug shape color needs three channels between 0 and 1');
    }
    if (checkerMeters !== undefined && !(typeof checkerMeters === 'number' && checkerMeters > 0)) {
      throw new GlobeError(
        'invalid-option',
        `checkerMeters must be a positive number, got ${describeInput(checkerMeters)}`,
      );
    }
  }
}

/** Converts a debug quad to renderer data: corners as float32 offsets from their float64 centroid (ADR 0004). */
function buildDebugMesh(shape: DebugShape): DebugMeshData {
  const ecef: number[] = [];
  for (const position of shape.corners) {
    const values = [position.longitudeDeg, position.latitudeDeg, position.heightMeters ?? 0];
    if (!values.every((v) => typeof v === 'number' && Number.isFinite(v)) || Math.abs(position.latitudeDeg) > 90) {
      throw new GlobeError('invalid-coordinate', `Debug shape corner out of range: ${describeInput(position)}`);
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

/** Validated shapes as meshes; before the renderer exists they are kept and handed over when it starts (KB-042). */
export function debugMeshesOf(shapes: readonly DebugShape[]): DebugMeshData[] {
  validateDebugShapes(shapes);
  return shapes.map((shape) => buildDebugMesh(shape));
}
