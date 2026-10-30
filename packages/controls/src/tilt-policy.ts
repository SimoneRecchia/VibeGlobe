// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { NavigationApi } from '@vibeglobe/core';
import type { ConnectedGlobe } from './camera-port.js';
import type { TiltPolicy } from './options.js';

/**
 * The controls' side of the tilt policy (F625): the engine applies it each frame from `NavigationApi.tiltPolicy`; the
 * controls write it there, announce when tilting becomes available or not, and end a tilt chosen by hand once the
 * camera passes the lock.
 */
export class TiltPolicyState {
  /** False while the policy's lock keeps the view flat. */
  available = true;
  private readonly listeners = new Set<(available: boolean) => void>();

  constructor(public policy: TiltPolicy | null) {}

  /** Writes the policy into the engine's array: `[0]` 0 turns it off. */
  write(navigation: NavigationApi | undefined): void {
    const target = navigation?.tiltPolicy;
    if (!target) return;
    target[0] = this.policy?.lock2DAboveMeters ?? 0;
    target[1] = this.policy?.autoTiltBelowMeters ?? 0;
    target[2] = ((this.policy?.autoTiltMaxDeg ?? 0) * Math.PI) / 180;
    target[3] = 1;
    target[4] = this.policy?.fullTiltBelowMeters ?? 0;
  }

  /** Once per frame: back to the zoom-driven tilt beyond the lock, and the listeners told of a change. */
  check(navigation: NavigationApi | undefined, globe: ConnectedGlobe | undefined): void {
    const now = this.policy === null || navigation?.tiltPolicy?.[3] !== 0;
    if (!now && globe?.viewMode === 'manual') globe.setViewMode?.('auto');
    if (now === this.available) return;
    this.available = now;
    for (const listener of this.listeners) listener(now);
  }

  /** Adds a listener of availability changes; returns its removal. */
  listen(listener: (available: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
