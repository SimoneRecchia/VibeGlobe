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
    this.count = selectQuadtreeTiles(camera, { ...selection, morph: undefined }, this.tiles);
  }

  /** The flight ended or was replaced. */
  clear(): void {
    this.count = 0;
  }
}
