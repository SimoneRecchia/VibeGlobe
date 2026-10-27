// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * @packageDocumentation
 * Quality presets and adaptive quality for VibeGlobe (F399–F402, ADR 0122): the presets low, medium, high and ultra,
 * a start-up choice from capability detection, and a frame-time governor with hysteresis that steps detail and
 * resolution down when frames are slow and back up once they are stable, driving a globe through its public API.
 * @module @vibeglobe/quality
 */
export { FrameTimeGovernor, GOVERNOR_DEFAULTS } from './governor.js';
export type { GovernorDecision, GovernorOptions } from './governor.js';
export {
  adaptiveLadder,
  isPresetName,
  MAX_ADAPTIVE_SCREEN_ERROR_PX,
  MIN_ADAPTIVE_RESOLUTION_SCALE,
  PRESET_NAMES,
  QUALITY_PRESETS,
} from './presets.js';
export type { AntialiasMode, AtmosphereLevel, QualityPresetName, QualitySettings } from './presets.js';
export { createQuality } from './quality.js';
export type {
  AppliedQualitySettings,
  QualityChange,
  QualityChangeReason,
  QualityController,
  QualityOptions,
  QualityTarget,
} from './quality.js';
export { browserHints, choosePreset } from './startup.js';
export type { CapabilityProfile, DeviceHints, PresetChoice } from './startup.js';
