// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { NavigationApi } from '@vibeglobe/core';
import type { ConnectedGlobe } from './camera-port.js';
import { validTiltPolicy, type TiltPolicy } from './options.js';

/**
 * The controls' side of the tilt policy (F625): the engine applies it each frame from `NavigationApi.tiltPolicy`; the
 * controls write it there, announce when tilting becomes available or not, and end a chosen tilt once the camera passes
 * the lock, except while the API movement that chose it runs (a flight from afar to a tilted view, KB-310).
 */
export class TiltPolicyState {
  /** False while the policy's lock keeps the view flat. */
  available = true;
  private readonly listeners = new Set<(available: boolean) => void>();
  private moving = false;
  private unfollow: (() => void) | undefined;

  constructor(public policy: TiltPolicy | null) {}

  /** Sets the policy, validated with the largest tilt input asks for, writes it and asks the engine for a frame. */
  set(next: unknown, maxTiltDeg: number, navigation: NavigationApi | undefined): void {
    this.policy = validTiltPolicy(next, maxTiltDeg);
    this.write(navigation);
    navigation?.requestUpdate();
  }

  /** The largest tilt the engine's last frame allowed, degrees (F642, `[5]`); 90 before the controls are attached. */
  maxTiltDeg(navigation: NavigationApi | undefined): number {
    return ((navigation?.tiltPolicy?.[5] ?? Math.PI / 2) * 180) / Math.PI;
  }

  /** Writes the policy into the engine's array: `[0]` 0 turns it off. */
  write(navigation: NavigationApi | undefined): void {
    const target = navigation?.tiltPolicy;
    if (!target) return;
    target[0] = this.policy?.lock2DAboveMeters ?? 0;
    target[1] = this.policy?.autoTiltBelowMeters ?? 0;
    target[2] = ((this.policy?.autoTiltMaxDeg ?? 0) * Math.PI) / 180;
    target[3] = 1;
    target[4] = this.policy ? Math.log2(this.policy.lock2DAboveMeters / this.policy.fullTiltBelowMeters) : 0;
  }

  /** Once per frame: back to the zoom-driven tilt beyond the lock, and the listeners told of a change. */
  check(navigation: NavigationApi | undefined, globe: ConnectedGlobe | undefined): void {
    const now = this.policy === null || navigation?.tiltPolicy?.[3] !== 0;
    if (!now && !this.moving && globe?.viewMode === 'manual') globe.setViewMode?.('auto');
    if (now === this.available) return;
    this.available = now;
    for (const listener of this.listeners) listener(now);
  }

  /**
   * Follows the globe's API movements, which {@link TiltPolicyState.check} lets finish their tilt. It listens for their
   * end only while one runs: a `moveend` listener makes the engine draw every display frame of user input (F200), which
   * the policy has no use for (KB-317).
   */
  follow(globe: ConnectedGlobe): void {
    this.unfollow?.();
    let offEnd: (() => void) | undefined;
    const end = (): void => {
      this.moving = false;
      offEnd?.();
      offEnd = undefined;
    };
    const offStart = globe.on?.('movestart', ({ cause }) => {
      this.moving = cause === 'api';
      if (this.moving) offEnd ??= globe.on?.('moveend', end);
    });
    this.unfollow = () => {
      offStart?.();
      offEnd?.();
    };
  }

  /** Adds a listener of availability changes; returns its removal. */
  listen(listener: (available: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
