// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { ViewMode, ViewPhase } from '../view/view-state.js';

/** The camera as the public API reports it: applied values, WGS84 degrees and meters. */
export interface CameraState {
  readonly longitudeDeg: number;
  readonly latitudeDeg: number;
  /** Web Mercator zoom, continuous. */
  readonly zoom: number;
  /** Eye height above the ellipsoid. */
  readonly altitudeMeters: number;
  readonly headingDeg: number;
  readonly tiltDeg: number;
  /** Roll about the viewing direction (0 for navigation). */
  readonly rollDeg: number;
  /** Distance from the eye to the target. */
  readonly rangeMeters: number;
  /** The eye's own position (the fields above place the target it looks at). */
  readonly eyeLongitudeDeg: number;
  readonly eyeLatitudeDeg: number;
  /**
   * Height above the ellipsoid of the surface the last frame showed under the eye: the terrain as drawn, its morph
   * included (F146, F147); 0 without terrain. `altitudeMeters` minus this is the eye's height above the ground.
   */
  readonly groundHeightMeters: number;
  /** The view mode: the zoom curves drive the tilt ('auto'), it stays 0° ('2d'), or the user chose it ('manual'). */
  readonly viewMode: ViewMode;
  /**
   * The tilt and heading the user chose (F164). `tiltDeg` and `headingDeg` are the applied values: a temporary clamp
   * (terrain, empty sky; F165, F166) or the Auto curve may lower the tilt, never the choice.
   */
  readonly chosenTiltDeg: number;
  readonly chosenHeadingDeg: number;
  /**
   * The largest tilt the view allows now (F642): the empty-sky limit, the camera constraints' `maxTiltDeg` and the
   * controls' tilt policy, or the tilt terrain clearance holds the camera at while it does, so a tilt slider can show
   * the reachable range.
   */
  readonly maxTiltDeg: number;
  /** The globe-to-flat morph factor the last frame drew: 0 the globe, 1 the flat map (ADR 0008). */
  readonly morphFactor: number;
  /** The share of terrain relief the last frame drew: 0 flat, 1 full height. */
  readonly reliefFactor: number;
  /** The phase of the last frame (`PLAN.md`, Map experience). */
  readonly phase: ViewPhase;
}
