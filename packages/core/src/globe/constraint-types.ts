// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { GeoBounds } from './types.js';

/** Limits on the camera (F209–F211): zoom range, maximum tilt, and bounds for the view's center. */
export interface CameraConstraints {
  readonly minZoom?: number;
  readonly maxZoom?: number;
  /** Farthest range (eye to target), 1–6 × 10⁷ m, at every latitude: `minZoom` (Web Mercator) nears the poles (F646). */
  readonly maxRangeMeters?: number;
  readonly maxTiltDeg?: number;
  readonly bounds?: GeoBounds;
  /**
   * How near a zoom in may bring the eye to the surface it zooms toward, meters (KB-300; default 40, 0 for none): the
   * terrain as drawn, mountains included, or the ellipsoid without terrain. The zoom stops there, so the view always
   * shows the ground it frames.
   */
  readonly minSurfaceDistanceMeters?: number;
}
