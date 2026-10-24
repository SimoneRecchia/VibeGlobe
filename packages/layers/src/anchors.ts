// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { GeoPosition, ScreenPoint } from '@vibeglobe/core';
import type { FeatureStore } from './feature-store.js';

/** Where a position shows on screen (at the terrain's height under it with `onGround`), or undefined behind the globe. */
export type Project = (position: GeoPosition, onGround: boolean) => ScreenPoint | undefined;

/** Whether a feature anchor of `store` shows within `radiusPx` of `point` (a press that starts a drag, F382). */
export function anchorNear(
  store: FeatureStore,
  point: ScreenPoint,
  radiusPx: number,
  project: Project,
  onGround: boolean,
): boolean {
  const p = store.array('position');
  for (let i = 0; i < store.count; i++) {
    const position = { longitudeDeg: p[3 * i] ?? 0, latitudeDeg: p[3 * i + 1] ?? 0, heightMeters: p[3 * i + 2] ?? 0 };
    const shown = project(position, onGround);
    if (shown && Math.hypot(shown.xPx - point.xPx, shown.yPx - point.yPx) <= radiusPx) return true;
  }
  return false;
}
