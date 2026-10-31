// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { Camera } from '../camera/camera.js';
import { cameraZoom } from '../camera/zoom.js';
import { MAX_FACTOR, SLOW_LINK_BPS_HERE } from './motion-detail.js';
import {
  selectQuadtreeTiles,
  type QuadtreeSelectionOptions,
  type QuadtreeTile,
} from '../surface/surface-quadtree.hot.js';

/** A movement's duration is split in this many steps: the plan selects the views at the times between them (F670). */
const SAMPLES = 12;
/**
 * The views along a path are this much narrower and shorter than the camera's, at the same detail: the next samples
 * cover their edges, which the moving camera, between samples, may never show.
 */
const PATH_VIEW = 0.75;
/** The destination's view with its margin ring is this much wider and taller, at the same detail. */
const MARGIN = 1.5;
/** A path tile is wanted from this long before the time the movement first shows it: lazily, in time order. */
const AHEAD_MS = 2000;
/** At any moment the destination's view counts as needed within this time. */
const ARRIVAL_LEAD_MS = 1000;
/** Priority key units per millisecond of lead: a whole flight fits in the preload class. */
const KEYS_PER_MS = 1 / 8;
/** Texels of the destination's margin ring over the arrival's: three levels coarser. */
const RING_TEXELS = 8;
/** The most tiles a plan holds, so their GPU memory stays a small share of the budget. */
const MAX_TILES = 512;

/** What a plan needs of a movement: its duration and its pose at any engine time (`CameraAnimator`). */
export interface MovementPath {
  readonly durationMs: number;
  /** Writes the pose at engine time `io[0]` into the camera, its tilt into `io[1]` (radians); does not update it. */
  step(camera: Camera, io: Float64Array): boolean;
}

/**
 * What a movement will draw, loaded in the order it will need it (F286, F287, F670). When the movement starts, the
 * destination's view at the arrival's detail (whose ancestors a few levels up load first, so arrival is never blank),
 * the tiles its camera selects at times along the path, at the detail a moving camera shows (F288), each with the time
 * it first shows them, and a margin ring around the destination three levels coarser; each tile once, at most
 * {@link MAX_TILES}. Each frame, {@link FlightPlan.keysAt} orders them: the destination's view as if needed within a
 * second, the others from two seconds before their time until the next sample's. Allocates when it plans, not per
 * frame.
 */
export class FlightPlan {
  /** The planned surface tiles, the destination's first. */
  readonly tiles: QuadtreeTile[] = [];
  /** Each tile's key in the preload class at the last {@link FlightPlan.keysAt}, -1 while not wanted. */
  readonly keys = new Float64Array(MAX_TILES);
  /** The deepest Mercator zoom of the movement, at its start or its end: the layers its views draw (F635). */
  zoom = 0;
  count = 0;
  /** Tiles before this index are the destination's view. */
  arrival = 0;
  /** A flight runs: prefetch around the moving view waits for its end, which only loads what the flight shows (F287). */
  flying = false;
  private readonly times = new Float64Array(MAX_TILES);

  private spacingMs = 0;
  private readonly camera = new Camera();
  private readonly selected: QuadtreeTile[] = [];
  private readonly seen = new Set<number>();
  private readonly io = new Float64Array(2);
  /** The engine's selection rules (one object, so the same keys every time) without the morph. */
  private readonly globeSelection: QuadtreeSelectionOptions = { maxScreenErrorPx: 2, maxLevel: 0 };

  /**
   * Plans a movement from the current camera to `end` (longitude and latitude in radians, range in meters, heading and
   * tilt in radians, NaN for the current tilt), starting at engine time `startMs` along `path` (none: the destination
   * alone, needed now), with the engine's `selection` rules and its largest texel at rest; `link` is the measured link
   * (F301).
   */
  plan(
    current: Camera,
    end: Float64Array,
    selection: QuadtreeSelectionOptions,
    texelPx: number,
    startMs: number,
    path?: MovementPath,
    link?: { readonly bitsPerSecond: number },
  ): void {
    const io = this.io;
    const endMs = startMs + (path?.durationMs ?? 0);
    // The detail a moving camera shows: its coarsest, one level coarser again on a slow link (F288, F301).
    const slow = (link?.bitsPerSecond ?? Infinity) < SLOW_LINK_BPS_HERE;
    const moving = texelPx * MAX_FACTOR * (slow ? 2 : 1);
    // Measured on the globe: the flat map's morph is anchored at the current view, not along the movement.
    Object.assign(this.globeSelection, selection).morph = undefined;
    this.count = 0;
    this.seen.clear();
    this.spacingMs = (endMs - startMs) / SAMPLES;
    this.add(this.pose(current, end), texelPx, endMs);
    this.arrival = this.count;
    this.zoom = Math.max(cameraZoom(current), cameraZoom(this.camera));
    for (let k = 1; path && k < SAMPLES; k++) {
      const camera = this.pose(current, end, PATH_VIEW);
      io[0] = startMs + k * this.spacingMs;
      io[1] = current.pose.tiltRad;
      path.step(camera, io);
      camera.pose.tiltRad = io[1] ?? 0;
      camera.update();
      this.add(camera, moving, io[0] ?? 0);
    }
    // A margin ring around the destination, three levels coarser, needed with the arrival as the path's views are; on a
    // slow link, as prefetch, none (F302).
    if (!slow) this.add(this.pose(current, end, MARGIN), texelPx * RING_TEXELS, endMs);
  }

  /** Nothing to load ahead any more: the movement ended or was replaced. */
  clear(): void {
    this.count = 0;
    this.flying = false;
  }

  /** Writes each tile's key at engine time `now[0]` into {@link FlightPlan.keys}. Allocates nothing. */
  keysAt(now: Float64Array): void {
    for (let i = 0; i < this.count; i++) {
      const lead = (this.times[i] ?? 0) - (now[0] ?? 0);
      const path = i >= this.arrival;
      const most = path ? AHEAD_MS : ARRIVAL_LEAD_MS;
      this.keys[i] =
        path && (lead > most || lead < -this.spacingMs)
          ? -1
          : (lead < most ? (lead > 0 ? lead : 0) : most) * KEYS_PER_MS;
    }
  }

  /** The plan's camera at the destination, its viewport `widen` times the current one's at the same detail. */
  private pose(current: Camera, end: Float64Array, widen = 1): Camera {
    const camera = this.camera;
    const pose = camera.pose;
    const tilt = end[4] ?? Number.NaN;
    pose.targetLongitudeRad = end[0] ?? 0;
    pose.targetLatitudeRad = end[1] ?? 0;
    pose.rangeMeters = end[2] ?? current.pose.rangeMeters;
    pose.headingRad = end[3] ?? 0;
    pose.tiltRad = tilt === tilt ? tilt : current.pose.tiltRad;
    camera.fovYRad = 2 * Math.atan(widen * Math.tan(current.fovYRad / 2));
    camera.widthPx = current.widthPx * widen;
    camera.heightPx = current.heightPx * widen;
    camera.update();
    return camera;
  }

  /** Adds the tiles `camera` selects with texels up to `texelPx`, first shown at `timeMs`; planned tiles keep theirs. */
  private add(camera: Camera, texelPx: number, timeMs: number): void {
    this.globeSelection.maxTexelErrorPx = texelPx;
    const count = selectQuadtreeTiles(camera, this.globeSelection, this.selected);
    for (let i = 0; i < count && this.count < MAX_TILES; i++) {
      const tile = this.selected[i];
      if (!tile || this.seen.has(tile.key)) continue;
      this.seen.add(tile.key);
      Object.assign((this.tiles[this.count] ??= { ...tile }), tile);
      this.times[this.count++] = timeMs;
    }
  }
}
