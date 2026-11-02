// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** The showcase's tilt policy (on unless `?tiltPolicy=0`), lifted by the scenes that tilt views of whole regions. */
import type { SceneContext } from '../types.js';

/** Whether the page started with the tilt policy. */
export const TILT_POLICY = new URLSearchParams(location.search).get('tiltPolicy') !== '0';

/** Lets the scene tilt at any distance, and restores the policy when it is left. */
export function freeTilt(context: SceneContext): void {
  context.navigation?.setTiltPolicy(false);
  context.defer(() => context.navigation?.setTiltPolicy(TILT_POLICY));
}
