// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { Camera } from '../camera/camera.js';
import {
  selectQuadtreeTiles,
  type QuadtreeSelectionOptions,
  type QuadtreeTile,
} from '../surface/surface-quadtree.hot.js';

/**
 * The surface tiles a flight's destination will show (F286): selected once when the flight starts, for a camera at
 * the end pose (`end`: longitude and latitude in radians, range in meters, heading and tilt in radians, NaN for the
 * current tilt) with the current viewport and selection rules; the imagery wants their tiles every frame of the flight
 * so the arrival view is complete.
 */
export class FlightPreload {
  readonly tiles: QuadtreeTile[] = [];
  count = 0;
  /** A flight runs: prefetch around the moving view waits for its end, which only loads what the flight shows (F287). */
  flying = false;
  private readonly camera = new Camera();
  /** The engine's selection rules (one object, so the same keys every time) without the morph, reused each frame. */
  private readonly globeSelection: QuadtreeSelectionOptions = { maxScreenErrorPx: 2, maxLevel: 0 };

  /** Selects the destination's tiles; nothing for a destination the current view already shows at its zoom. */
  select(current: Camera, end: Float64Array, selection: QuadtreeSelectionOptions): void {
    const camera = this.camera;
    const pose = camera.pose;
    pose.targetLongitudeRad = end[0] ?? 0;
    pose.targetLatitudeRad = end[1] ?? 0;
    pose.targetHeightMeters = 0;
    pose.rangeMeters = end[2] ?? current.pose.rangeMeters;
    pose.headingRad = end[3] ?? 0;
    const tilt = end[4] ?? Number.NaN;
    pose.tiltRad = Number.isNaN(tilt) ? current.pose.tiltRad : tilt;
    camera.fovYRad = current.fovYRad;
    camera.widthPx = current.widthPx;
    camera.heightPx = current.heightPx;
    camera.update();
    // Measured on the globe: the flat map's morph is anchored at the current view, not at the destination.
    const globe = Object.assign(this.globeSelection, selection);
    globe.morph = undefined;
    this.count = selectQuadtreeTiles(camera, globe, this.tiles);
  }

  /** The flight ended or was replaced. */
  clear(): void {
    this.count = 0;
  }
}

/** During the descent, how far ahead along a flight its tiles come from, milliseconds (F287). */
const DESCENT_AHEAD_MS = 500;
/** Samples of a flight's path searched for its highest point. */
const PEAK_SAMPLES = 32;

/**
 * The view a flight will show next whose tiles load instead of the current view's (F287). Until its highest point,
 * the view there: its tiles are coarser than every view of the climb and cover them, so they draw at once and stay
 * drawn, where each level of the climb would be replaced by the next before it shows. After it, the view half a
 * second ahead: inside the current one, its tiles draw within the half second.
 */
export class FlightLookahead {
  /** Longitude, latitude (radians), range (meters), heading and tilt (radians) ahead, as `FlightPreload.select` takes. */
  readonly end = new Float64Array(5);
  private readonly camera = new Camera();
  private readonly io = new Float64Array(2);
  /** The engine time of the running flight's highest point. */
  private readonly peakMs = new Float64Array(1);

  /** Finds the highest point of a flight starting at `startMs` and lasting `durationMs` (once, when it starts). */
  plan(animator: FlightAnimator, current: Camera, startMs: number, durationMs: number): void {
    let highest = -1;
    this.peakMs[0] = startMs;
    for (let i = 1; i <= PEAK_SAMPLES; i++) {
      const atMs = startMs + (durationMs * i) / PEAK_SAMPLES;
      const range = this.evaluate(animator, current, atMs)[2] ?? 0;
      if (range > highest) {
        highest = range;
        this.peakMs[0] = atMs;
      }
    }
  }

  /** Writes the pose whose tiles load at the engine time `nowMs` into {@link end}. */
  poseAhead(animator: FlightAnimator, current: Camera, nowMs: number): Float64Array {
    const peakMs = this.peakMs[0] ?? 0;
    return this.evaluate(animator, current, nowMs < peakMs ? peakMs : nowMs + DESCENT_AHEAD_MS);
  }

  private evaluate(animator: FlightAnimator, current: Camera, atMs: number): Float64Array {
    const camera = this.camera;
    const from = current.pose;
    const pose = camera.pose;
    camera.fovYRad = current.fovYRad;
    camera.widthPx = current.widthPx;
    camera.heightPx = current.heightPx;
    pose.targetHeightMeters = from.targetHeightMeters;
    pose.tiltRad = from.tiltRad;
    this.io[0] = atMs;
    this.io[1] = from.tiltRad;
    animator.step(camera, this.io);
    const end = this.end;
    end[0] = pose.targetLongitudeRad;
    end[1] = pose.targetLatitudeRad;
    end[2] = pose.rangeMeters;
    end[3] = pose.headingRad;
    end[4] = this.io[1] ?? Number.NaN;
    return end;
  }
}

/** What {@link FlightLookahead} needs of a flight: its pose at any engine time. */
interface FlightAnimator {
  step(camera: Camera, io: Float64Array): boolean;
}
