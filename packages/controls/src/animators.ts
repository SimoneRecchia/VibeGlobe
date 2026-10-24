// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { GeoPosition } from '@vibeglobe/core';
import type { CameraPort } from './camera-port.js';
import { approachShare, inertiaOffset, inertiaRemaining, SmoothedVelocity } from './motion.js';

/** A screen point overwritten in place. */
export interface MutablePoint {
  xPx: number;
  yPx: number;
}

/** The longest first step of an animation: one frame at 30 Hz. */
const MAX_FIRST_STEP_MS = 34;

/**
 * Engine time of an animation. Input arrives between frames, so an animation starts at the previous frame's time (at
 * most one 30 Hz frame back, after an idle engine), and every step covers exactly the engine time since the one before:
 * a trajectory depends on time alone, not on the refresh rate (F203).
 */
class Timeline {
  private lastMs = NaN;
  startMs = NaN;

  /** Restarts at the next step. */
  reset(): void {
    this.lastMs = NaN;
    this.startMs = NaN;
  }

  /** The engine time since the previous step, or since the previous frame (`previousFrameMs`) on the first. */
  step(nowMs: number, previousFrameMs: number): number {
    if (Number.isNaN(this.lastMs)) {
      this.lastMs = Math.min(nowMs, Math.max(previousFrameMs, nowMs - MAX_FIRST_STEP_MS));
      this.startMs = this.lastMs;
    }
    const dt = Math.max(0, nowMs - this.lastMs);
    this.lastMs = nowMs;
    return dt;
  }
}

/** Remaining motion below these ends inertia (ADR 0009 §6: 0.1 px). */
const PAN_REST_PX = 0.1;
const ANGLE_REST_DEG = 0.01;
const ZOOM_REST_LEVELS = 0.0005;

/** Velocities a release carries on, per millisecond. */
export interface ReleaseVelocity {
  panXPx: number;
  panYPx: number;
  headingDeg: number;
  tiltDeg: number;
  zoomLevels: number;
}

/** Time constants of one inertia run. */
export interface InertiaTaus {
  readonly panTauMs: number;
  readonly rotateTauMs: number;
  readonly tiltTauMs: number;
  readonly zoomTauMs: number;
}

/**
 * Inertia after a release (ADR 0009 §6): each channel follows x(t) = v0·τ·(1 − e^(−t/τ)) in engine time since the
 * release, continuous in velocity at the release. Pan moves the grabbed anchor along the release direction (a great
 * circle on the globe); zoom stays anchored at the pan pixel.
 */
export class Inertia {
  active = false;
  private readonly timeline = new Timeline();
  private readonly v: ReleaseVelocity = { panXPx: 0, panYPx: 0, headingDeg: 0, tiltDeg: 0, zoomLevels: 0 };
  private taus: InertiaTaus = { panTauMs: 1, rotateTauMs: 1, tiltTauMs: 1, zoomTauMs: 1 };
  private anchor: GeoPosition | undefined;
  private readonly origin: MutablePoint = { xPx: 0, yPx: 0 };
  private readonly pixel: MutablePoint = { xPx: 0, yPx: 0 };
  private elapsedMs = 0;
  private maxTiltDeg = 89;

  /** Starts from a release at `pixel` with the drag's anchor (or none for rotation and zoom only). */
  start(
    velocity: ReleaseVelocity,
    taus: InertiaTaus,
    anchor: GeoPosition | undefined,
    pixel: MutablePoint,
    maxTiltDeg: number,
  ): void {
    Object.assign(this.v, velocity);
    if (!anchor) {
      this.v.panXPx = 0;
      this.v.panYPx = 0;
    }
    this.taus = taus;
    this.anchor = anchor;
    this.origin.xPx = pixel.xPx;
    this.origin.yPx = pixel.yPx;
    this.maxTiltDeg = maxTiltDeg;
    this.elapsedMs = 0;
    this.timeline.reset();
    this.active = !this.resting(0);
  }

  /** Stops at once. */
  stop(): void {
    this.active = false;
    this.anchor = undefined;
  }

  private resting(t: number): boolean {
    const { v, taus } = this;
    const pan = Math.hypot(inertiaRemaining(v.panXPx, taus.panTauMs, t), inertiaRemaining(v.panYPx, taus.panTauMs, t));
    return (
      pan < PAN_REST_PX &&
      Math.abs(inertiaRemaining(v.headingDeg, taus.rotateTauMs, t)) < ANGLE_REST_DEG &&
      Math.abs(inertiaRemaining(v.tiltDeg, taus.tiltTauMs, t)) < ANGLE_REST_DEG &&
      Math.abs(inertiaRemaining(v.zoomLevels, taus.zoomTauMs, t)) < ZOOM_REST_LEVELS
    );
  }

  /** Advances to `nowMs`; returns whether inertia continues. */
  step(nowMs: number, port: CameraPort): boolean {
    if (!this.active) return false;
    const before = this.elapsedMs;
    const t = (this.elapsedMs += this.timeline.step(nowMs, port.previousFrameMs));
    if (t === before) return true;
    const { v, taus } = this;
    // The engine announces these changes with the cause 'inertia' (F200).
    port.setCoasting(true);
    const dHeading =
      inertiaOffset(v.headingDeg, taus.rotateTauMs, t) - inertiaOffset(v.headingDeg, taus.rotateTauMs, before);
    const dTilt = inertiaOffset(v.tiltDeg, taus.tiltTauMs, t) - inertiaOffset(v.tiltDeg, taus.tiltTauMs, before);
    port.rotate(dHeading, dTilt, this.maxTiltDeg);
    const dZoom = inertiaOffset(v.zoomLevels, taus.zoomTauMs, t) - inertiaOffset(v.zoomLevels, taus.zoomTauMs, before);
    this.pixel.xPx = this.origin.xPx + inertiaOffset(v.panXPx, taus.panTauMs, t);
    this.pixel.yPx = this.origin.yPx + inertiaOffset(v.panYPx, taus.panTauMs, t);
    port.zoomAt(this.pixel, dZoom);
    if (this.anchor) port.dragTo(this.anchor, this.pixel);
    port.setCoasting(false);
    if (this.resting(t)) this.stop();
    return this.active;
  }
}

/**
 * A smoothed zoom target (ADR 0009 §4): wheel notches, the zoom commands and double-click add levels that the camera
 * approaches exponentially, anchored at a screen point; the last step applies exactly what remains, so a command ends
 * exactly one level further.
 */
export class ZoomTarget {
  pending = 0;
  tauMs = 100;
  readonly at: MutablePoint = { xPx: 0, yPx: 0 };
  private readonly timeline = new Timeline();

  /** Adds levels, anchored at a point; `maxLead` caps how far the target may lead the camera. */
  add(levels: number, xPx: number, yPx: number, tauMs: number, maxLead = Infinity): void {
    if (this.pending === 0) this.timeline.reset();
    this.pending = Math.min(Math.max(this.pending + levels, -maxLead), maxLead);
    this.at.xPx = xPx;
    this.at.yPx = yPx;
    this.tauMs = tauMs;
  }

  /** Stops at once. */
  stop(): void {
    this.pending = 0;
  }

  /** Advances to `nowMs`; returns whether levels remain. */
  step(nowMs: number, port: CameraPort): boolean {
    if (this.pending === 0) return false;
    const dt = this.timeline.step(nowMs, port.previousFrameMs);
    let levels = this.pending * approachShare(this.tauMs, dt);
    if (Math.abs(this.pending - levels) < ZOOM_REST_LEVELS || port.tooSlowFor(this.tauMs)) levels = this.pending;
    this.pending -= levels;
    port.zoomAt(this.at, levels);
    return this.pending !== 0;
  }
}

/** Shortest signed arc from `fromDeg` to `toDeg`, in (−180, 180]. */
function shortestArcDeg(fromDeg: number, toDeg: number): number {
  const d = ((((toDeg - fromDeg) % 360) + 540) % 360) - 180;
  return d === -180 ? 180 : d;
}

/** Turns the heading to a value along the shortest arc with an exponential approach (the reset-north key). */
export class HeadingTarget {
  active = false;
  private targetDeg = 0;
  private tauMs = 100;
  private readonly timeline = new Timeline();

  /** Starts turning toward `targetDeg`. */
  start(targetDeg: number, tauMs: number): void {
    this.targetDeg = targetDeg;
    this.tauMs = tauMs;
    this.active = true;
    this.timeline.reset();
  }

  /** Stops at once. */
  stop(): void {
    this.active = false;
  }

  /** Advances to `nowMs`; returns whether the turn continues. */
  step(nowMs: number, port: CameraPort, maxTiltDeg: number): boolean {
    if (!this.active) return false;
    const remaining = shortestArcDeg(port.headingDeg(), this.targetDeg);
    const dt = this.timeline.step(nowMs, port.previousFrameMs);
    let turn = remaining * approachShare(this.tauMs, dt);
    if (Math.abs(remaining - turn) < ANGLE_REST_DEG) {
      turn = remaining;
      this.active = false;
    }
    port.rotate(turn, 0, maxTiltDeg);
    return this.active;
  }
}

/** Held-key motion (ADR 0009 §4): pan, heading and tilt velocities with an eased start and stop. */
export class KeyMotion {
  readonly panX = new SmoothedVelocity();
  readonly panY = new SmoothedVelocity();
  readonly heading = new SmoothedVelocity();
  readonly tilt = new SmoothedVelocity();
  private readonly timeline = new Timeline();
  private readonly center: MutablePoint = { xPx: 0, yPx: 0 };
  private readonly moved: MutablePoint = { xPx: 0, yPx: 0 };
  private running = false;

  /** True while any held-key velocity is not at rest. */
  get moving(): boolean {
    return this.panX.moving || this.panY.moving || this.heading.moving || this.tilt.moving;
  }

  /** Stops at once. */
  stop(): void {
    this.panX.stop();
    this.panY.stop();
    this.heading.stop();
    this.tilt.stop();
    this.running = false;
  }

  /** Advances to `nowMs` in a viewport of the given size; returns whether keys still move the camera. */
  step(nowMs: number, port: CameraPort, tauMs: number, widthPx: number, heightPx: number, maxTiltDeg: number): boolean {
    if (!this.moving) {
      this.running = false;
      return false;
    }
    if (!this.running) {
      this.running = true;
      this.timeline.reset();
    }
    const dt = this.timeline.step(nowMs, port.previousFrameMs);
    if (dt === 0) return true;
    port.rotate(this.heading.step(tauMs, dt), this.tilt.step(tauMs, dt), maxTiltDeg);
    const dx = this.panX.step(tauMs, dt);
    const dy = this.panY.step(tauMs, dt);
    if (dx !== 0 || dy !== 0) {
      this.center.xPx = widthPx / 2;
      this.center.yPx = heightPx / 2;
      const anchor = port.grab(this.center);
      // The view moves by (dx, dy): the point at the center moves the other way.
      this.moved.xPx = this.center.xPx - dx;
      this.moved.yPx = this.center.yPx - dy;
      if (anchor) port.dragTo(anchor, this.moved);
    }
    // At rest the next press starts a new timeline: the update skips this step while nothing moves (KB-124).
    if (!this.moving) this.running = false;
    return this.moving;
  }
}
