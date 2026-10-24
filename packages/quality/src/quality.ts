// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { FrameTimeGovernor, type GovernorOptions } from './governor.js';
import {
  adaptiveLadder,
  isPresetName,
  QUALITY_PRESETS,
  type QualityPresetName,
  type QualitySettings,
} from './presets.js';
import { browserHints, choosePreset, type CapabilityProfile, type DeviceHints, type PresetChoice } from './startup.js';

/** Settings as applied: the anisotropy resolved to a number of the device's range. */
export interface AppliedQualitySettings extends QualitySettings {
  readonly anisotropy: number;
}

/**
 * The part of a `Globe` adaptive quality drives (its public API). `setQualitySettings` is the engine hook that
 * applies level of detail and effects (docs/parallel-tracks.md, "Hook requests"); until a globe has it, only the
 * resolution scale changes, through `setResolutionScale`.
 */
export interface QualityTarget {
  readonly capabilities: CapabilityProfile | undefined;
  on(event: 'frame', handler: (payload: { readonly frameNumber: number }) => void): () => void;
  setResolutionScale(scale: number): void;
  requestRender(): void;
  setQualitySettings?(settings: AppliedQualitySettings): void;
}

/** Options of {@link createQuality}. */
export interface QualityOptions {
  /** The preset, or 'auto' (default) to choose it from capability detection (F400). */
  readonly preset?: QualityPresetName | 'auto';
  /** Adaptive quality (F401, F402): on by default; `false` keeps the preset fixed; an object tunes the governor. */
  readonly adaptive?: boolean | GovernorOptions;
  /** Device hints for the 'auto' choice (default: read from the browser). */
  readonly hints?: DeviceHints;
  /** Clock in milliseconds that frame times are measured on (default `performance.now`). */
  readonly now?: () => number;
}

/** Why the quality changed. */
export type QualityChangeReason = 'start' | 'preset' | 'lower' | 'raise';

/** A change of the applied quality. */
export interface QualityChange {
  readonly reason: QualityChangeReason;
  readonly preset: QualityPresetName;
  /** The adaptive level: 0 is the preset, higher is cheaper. */
  readonly level: number;
  readonly settings: AppliedQualitySettings;
}

/** Quality presets and adaptive quality on one globe. */
export interface QualityController {
  readonly preset: QualityPresetName;
  /** Why 'auto' chose the preset; undefined for an explicit preset. */
  readonly choice: PresetChoice | undefined;
  readonly level: number;
  readonly settings: AppliedQualitySettings;
  readonly adaptive: boolean;
  /** Switches the preset at runtime (F399); the adaptive level restarts at the preset. */
  setPreset(preset: QualityPresetName): void;
  setAdaptive(enabled: boolean): void;
  /** Subscribes to quality changes; returns an unsubscribe function. */
  onChange(handler: (change: QualityChange) => void): () => void;
  /** Stops watching frames. The applied settings stay. */
  destroy(): void;
}

function resolve(settings: QualitySettings, capabilities: CapabilityProfile | undefined): AppliedQualitySettings {
  const maxAnisotropy = Math.max(capabilities?.maxAnisotropy ?? 1, 1);
  const anisotropy = settings.anisotropy === 'max' ? maxAnisotropy : Math.min(settings.anisotropy, maxAnisotropy);
  return { ...settings, anisotropy };
}

function startPreset(
  target: QualityTarget,
  options: QualityOptions,
): { preset: QualityPresetName; choice: PresetChoice | undefined } {
  const requested = options.preset ?? 'auto';
  if (requested !== 'auto') {
    if (!isPresetName(requested)) throw new TypeError(`unknown quality preset ${String(requested)}`);
    return { preset: requested, choice: undefined };
  }
  const choice = target.capabilities
    ? choosePreset(target.capabilities, options.hints ?? browserHints())
    : { preset: 'medium' as const, reason: 'capabilities not known yet (create after globe.ready)' };
  return { preset: choice.preset, choice };
}

class Quality implements QualityController {
  preset: QualityPresetName;
  choice: PresetChoice | undefined;
  adaptive: boolean;
  settings: AppliedQualitySettings;
  private ladder: QualitySettings[];
  private governor: FrameTimeGovernor;
  private readonly handlers = new Set<(change: QualityChange) => void>();
  private readonly unsubscribe: () => void;
  private readonly now: () => number;
  private readonly governorOptions: GovernorOptions;

  constructor(
    private readonly target: QualityTarget,
    options: QualityOptions,
  ) {
    this.now = options.now ?? (() => globalThis.performance.now());
    this.governorOptions = typeof options.adaptive === 'object' ? options.adaptive : {};
    this.adaptive = options.adaptive !== false;
    ({ preset: this.preset, choice: this.choice } = startPreset(target, options));
    this.ladder = adaptiveLadder(QUALITY_PRESETS[this.preset]);
    this.governor = new FrameTimeGovernor(this.ladder.length, this.governorOptions);
    this.settings = resolve(QUALITY_PRESETS[this.preset], target.capabilities);
    this.unsubscribe = target.on('frame', () => {
      if (!this.adaptive) return;
      const decision = this.governor.frame(this.now());
      if (decision) this.apply(decision.level, decision.direction);
    });
    this.apply(0, 'start');
  }

  get level(): number {
    return this.governor.level;
  }

  private apply(level: number, reason: QualityChangeReason): void {
    this.settings = resolve(this.ladder[level] ?? QUALITY_PRESETS[this.preset], this.target.capabilities);
    this.target.setResolutionScale(this.settings.resolutionScale);
    this.target.setQualitySettings?.(this.settings);
    this.target.requestRender();
    const change: QualityChange = { reason, preset: this.preset, level, settings: this.settings };
    for (const handler of this.handlers) handler(change);
  }

  setPreset(preset: QualityPresetName): void {
    if (!isPresetName(preset)) throw new TypeError(`unknown quality preset ${String(preset)}`);
    this.preset = preset;
    this.choice = undefined;
    this.ladder = adaptiveLadder(QUALITY_PRESETS[preset]);
    this.governor = new FrameTimeGovernor(this.ladder.length, this.governorOptions);
    this.governor.reset(0, this.now());
    this.apply(0, 'preset');
  }

  setAdaptive(enabled: boolean): void {
    this.adaptive = enabled;
    if (!enabled && this.governor.level !== 0) {
      this.governor.reset(0, this.now());
      this.apply(0, 'preset');
    } else this.governor.reset(this.governor.level, this.now());
  }

  onChange(handler: (change: QualityChange) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  destroy(): void {
    this.unsubscribe();
    this.handlers.clear();
  }
}

/**
 * Applies a quality preset to a globe and, unless `adaptive` is false, adapts it to the frame time (F399–F402): it
 * measures the interval between drawn frames, lowers one ladder step ({@link adaptiveLadder}) when frames stay slow
 * and raises one step back once they are fast for the governor's stable interval. Create it after `globe.ready`, so
 * the 'auto' preset reads the device's capabilities; an explicit preset overrides detection.
 */
export function createQuality(target: QualityTarget, options: QualityOptions = {}): QualityController {
  return new Quality(target, options);
}
