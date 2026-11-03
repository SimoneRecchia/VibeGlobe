// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * @packageDocumentation
 * Motion blur (F694), a separate entry point so applications without it never bundle it:
 * `createRenderer({ motionBlur })`, then `QualitySettings.motionBlur` turns it on and sets its level.
 * @module @vibeglobe/renderer/motion-blur
 */

/** Loads the motion blur's pass when the quality settings first turn it on. */
export const motionBlur = (): Promise<typeof import('./motion-blur-pass.js')> => import('./motion-blur-pass.js');
