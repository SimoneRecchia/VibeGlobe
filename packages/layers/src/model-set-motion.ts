// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Radians per millisecond in a turn per minute. */
const RPM = (2 * Math.PI) / 60_000;
const RAD = Math.PI / 180;
const TURN = 2 * Math.PI;
/** The golden angle: copies start at well-spread angles, so a farm never turns in step. */
const PHASE_STEP = 2.399_963;

/** Throws unless `value` is a finite number; returns it. */
export function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be a finite number`);
  return value;
}

/**
 * The spinning parts of a model set's copies (F648), such as rotors: each copy's angle about the part's Z axis and its
 * speed, eased toward a target over `rampSeconds` as a rotor speeds up and slows down.
 */
export class SpinMotion {
  /** Radians by copy, read by the renderer every frame. */
  readonly angles: Float32Array;
  readonly #rates: Float64Array;
  readonly #targets: Float64Array;
  readonly #rampMs: number;

  constructor(rpms: readonly number[], rampSeconds: number) {
    if (!(rampSeconds >= 0 && Number.isFinite(rampSeconds)))
      throw new RangeError('spin.rampSeconds must be a number ≥ 0');
    // A third of a turn apart at most: three blades look the same every 120°.
    this.angles = Float32Array.from(rpms, (_, i) => (i * PHASE_STEP) % (TURN / 3));
    this.#targets = Float64Array.from(rpms, (rpm) => finite(rpm, 'A spin speed') * RPM);
    this.#rates = Float64Array.from(this.#targets);
    this.#rampMs = rampSeconds * 1000;
  }

  /** Advances `dtMs`; true while a part turns. */
  step(dtMs: number): boolean {
    const ease = this.#rampMs > 0 ? 1 - Math.exp((-3 * dtMs) / this.#rampMs) : 1;
    let turning = false;
    for (let i = 0; i < this.angles.length; i++) {
      let rate = this.#rates[i] ?? 0;
      // Eased, but by at least a turn per minute each second, so the last of a change does not linger.
      const gap = (this.#targets[i] ?? 0) - rate;
      rate += Math.sign(gap) * Math.max(Math.abs(gap) * ease, Math.min(Math.abs(gap), (RPM * dtMs) / 1000));
      this.#rates[i] = rate;
      if (rate === 0) continue;
      turning = true;
      this.angles[i] = ((this.angles[i] ?? 0) + rate * dtMs) % TURN;
    }
    return turning;
  }

  /** Sets the turns per minute of every copy, or of the copy at `index`. */
  set(rpm: number, index?: number): void {
    const rate = finite(rpm, 'A spin speed') * RPM;
    if (index === undefined) this.#targets.fill(rate);
    else this.#targets[index] = rate;
  }

  /** The turns per minute the copy at `index` is heading for. */
  target(index: number): number | undefined {
    const rate = this.#targets[index];
    return rate === undefined ? undefined : rate / RPM;
  }
}

/**
 * The yawing parts of a model set's copies (F648), such as nacelles on their towers: each copy's angle about the part's
 * Y axis, from the copy's heading, turned toward the direction it is to face at `degPerSecond`, the shorter way round.
 */
export class YawMotion {
  /** Radians about +Y (counter-clockwise seen from above) by copy, read by the renderer every frame. */
  readonly angles: Float32Array;
  /** Float32 as the angles, so a part that reached its target sits exactly on it. */
  readonly #targets: Float32Array;
  readonly #headingsDeg: Float64Array;
  readonly #ratePerMs: number;

  constructor(headingsDeg: readonly number[], facingDeg: readonly number[], degPerSecond: number) {
    if (!(degPerSecond > 0 && Number.isFinite(degPerSecond)))
      throw new RangeError('yaw.degPerSecond must be a positive number');
    this.#headingsDeg = Float64Array.from(headingsDeg);
    this.#targets = Float32Array.from(facingDeg, (facing, i) => this.#angleFor(finite(facing, 'A yaw'), i));
    this.angles = Float32Array.from(this.#targets);
    this.#ratePerMs = (degPerSecond * RAD) / 1000;
  }

  /** Advances `dtMs`; true while a part turns. */
  step(dtMs: number): boolean {
    let turning = false;
    for (let i = 0; i < this.angles.length; i++) {
      const angle = this.angles[i] ?? 0;
      const target = this.#targets[i] ?? 0;
      const gap = wrap(target - angle);
      if (target === angle) continue;
      turning = true;
      const step = this.#ratePerMs * dtMs;
      this.angles[i] = Math.abs(gap) <= step ? target : wrap(angle + Math.sign(gap) * step);
    }
    return turning;
  }

  /** Turns every copy, or the copy at `index`, to face `facingDeg`, clockwise from north. */
  set(facingDeg: number, index?: number): void {
    finite(facingDeg, 'A yaw');
    if (index !== undefined) this.#targets[index] = this.#angleFor(facingDeg, index);
    else for (let i = 0; i < this.#targets.length; i++) this.#targets[i] = this.#angleFor(facingDeg, i);
  }

  /** The direction the copy at `index` is turning to face, degrees clockwise from north in [0, 360). */
  target(index: number): number | undefined {
    const angle = this.#targets[index];
    if (angle === undefined) return undefined;
    const facing = (this.#headingsDeg[index] ?? 0) - angle / RAD;
    return ((facing % 360) + 360) % 360;
  }

  /** The angle about +Y that faces `facingDeg` for the copy at `index` (a heading turns about −Y). */
  #angleFor(facingDeg: number, index: number): number {
    return wrap(-(facingDeg - (this.#headingsDeg[index] ?? 0)) * RAD);
  }
}

/** An angle in (−π, π]. */
function wrap(angle: number): number {
  const a = angle - TURN * Math.floor((angle + Math.PI) / TURN);
  return a === -Math.PI ? Math.PI : a;
}
