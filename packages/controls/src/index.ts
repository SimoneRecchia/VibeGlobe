/**
 * @packageDocumentation
 * Input handling, gestures and navigation logic.
 * @module @vibeglobe/controls
 */
export { createControls } from './create-controls.js';
export type { NavigationControls } from './create-controls.js';
export type { ConnectedGlobe } from './camera-port.js';
export { DEFAULT_CONTROLS_OPTIONS, resolveControlsOptions } from './options.js';
export type {
  ControlsOptions,
  GestureSwitches,
  InertiaSettings,
  KeyboardSettings,
  ResolvedControlsOptions,
  TouchSettings,
  WheelSettings,
} from './options.js';
