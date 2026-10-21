import type { DebugShape, GeoPosition } from '@vibeglobe/core';
import { MARKER_HALF_SIZE_DEG } from './protocol.js';

/** A pure red square around a position, drawn in the scene; the DOM overlay frames it in green. */
export function markerShape(at: GeoPosition): DebugShape {
  const corner = (dLon: number, dLat: number): GeoPosition => ({
    longitudeDeg: at.longitudeDeg + dLon * MARKER_HALF_SIZE_DEG,
    latitudeDeg: at.latitudeDeg + dLat * MARKER_HALF_SIZE_DEG,
    heightMeters: 1000,
  });
  return { corners: [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)], colorRgb: [1, 0, 0] };
}
