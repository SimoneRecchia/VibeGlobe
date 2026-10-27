// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * @packageDocumentation
 * Input handling, gestures and navigation logic.
 * @module @vibeglobe/controls
 */
export { createControls } from './create-controls.js';
export type { NavigationControls } from './create-controls.js';
export type { ConnectedGlobe } from './camera-port.js';
export { DEFAULT_CONTROLS_OPTIONS, DEFAULT_TILT_POLICY, resolveControlsOptions } from './options.js';
export type {
  ControlsOptions,
  GestureSwitches,
  InertiaSettings,
  KeyboardSettings,
  ResolvedControlsOptions,
  TiltPolicy,
  TouchSettings,
  WheelSettings,
} from './options.js';
