// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Closed-form, time-based motion (ADR 0009 §4 and §6): every function is exact over any time step, so a trajectory is
 * the same at every refresh rate and after stalled frames.
 */

/** Distance covered by inertia `elapsedMs` after a release at `velocityPerMs`: v0·τ·(1 − e^(−t/τ)). */
export function inertiaOffset(velocityPerMs: number, tauMs: number, elapsedMs: number): number {
  return velocityPerMs * tauMs * (1 - Math.exp(-elapsedMs / tauMs));
}

/** Motion inertia still has to cover after `elapsedMs`: v0·τ·e^(−t/τ). */
export function inertiaRemaining(velocityPerMs: number, tauMs: number, elapsedMs: number): number {
  return velocityPerMs * tauMs * Math.exp(-elapsedMs / tauMs);
}

/** The share of a remaining distance an exponential approach with time constant τ covers in `dtMs`: 1 − e^(−dt/τ). */
export function approachShare(tauMs: number, dtMs: number): number {
  return 1 - Math.exp(-dtMs / tauMs);
}

/**
 * A velocity that approaches a target velocity with time constant τ (held keys, ADR 0009 §4). {@link step} advances it
 * by `dtMs` and returns the exact distance covered in that time, so the eased start and stop are frame-rate independent.
 */
export class SmoothedVelocity {
  /** Current velocity, per millisecond. */
  value = 0;
  /** Target velocity, per millisecond. */
  target = 0;

  /** Advances by `dtMs`; returns the distance covered meanwhile. */
  step(tauMs: number, dtMs: number): number {
    const share = approachShare(tauMs, dtMs);
    const difference = this.value - this.target;
    // ∫ (vt + (v0 − vt)·e^(−s/τ)) ds over [0, dt].
    const distance = this.target * dtMs + difference * tauMs * share;
    this.value = this.target + difference * (1 - share);
    if (this.target === 0 && Math.abs(this.value) < 1e-6) this.value = 0;
    return distance;
  }

  /** True while the velocity is not at rest. */
  get moving(): boolean {
    return this.value !== 0 || this.target !== 0;
  }

  /** Stops at once. */
  stop(): void {
    this.value = 0;
    this.target = 0;
  }
}
