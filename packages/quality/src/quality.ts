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
 * applies level of detail and effects (docs/internal/parallel-tracks.md, "Hook requests"); until a globe has it, only the
 * resolution scale changes, through `setResolutionScale`.
 */
export interface QualityTarget {
  readonly capabilities: CapabilityProfile | undefined;
  on(event: 'frame' | 'idle' | 'movestart' | 'move' | 'moveend', handler: (payload: unknown) => void): () => void;
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
export type QualityChangeReason = 'start' | 'preset' | 'lower' | 'raise' | 'rest' | 'motion';

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

function resolve(
  settings: QualitySettings,
  capabilities: CapabilityProfile | undefined,
  pixelRatio: number | undefined,
): AppliedQualitySettings {
  const { maxPixelRatio, ...engine } = settings;
  const maxAnisotropy = Math.max(capabilities?.maxAnisotropy ?? 1, 1);
  const anisotropy = engine.anisotropy === 'max' ? maxAnisotropy : Math.min(engine.anisotropy, maxAnisotropy);
  // A dense screen draws no more pixels per CSS pixel than the level allows; the engine gets only its own settings.
  const densest = (maxPixelRatio ?? Infinity) / (pixelRatio ?? 1);
  const resolutionScale = Math.round(Math.min(engine.resolutionScale, densest) * 1000) / 1000;
  return { ...engine, anisotropy, resolutionScale };
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

/**
 * A camera with no movement for this long and this many frames rests, though frames go on (an animation): the preset
 * shows in full. The frames keep a slow device's drag, whose frames can come without the input's next move, moving.
 */
const REST = { ms: 150, frames: 3 };

class Quality implements QualityController {
  preset: QualityPresetName;
  choice: PresetChoice | undefined;
  adaptive: boolean;
  settings: AppliedQualitySettings;
  private ladder: QualitySettings[];
  private governor: FrameTimeGovernor;
  private readonly handlers = new Set<(change: QualityChange) => void>();
  private readonly unsubscribe: (() => void)[];
  private readonly now: () => number;
  private readonly governorOptions: GovernorOptions;
  /** The device pixel ratio at the start, which the levels' `maxPixelRatio` is measured against. */
  private readonly pixelRatio: number | undefined;
  /** When a movement event last came, and the frames since; before the first, every frame is judged. */
  private movedAtMs = Number.NEGATIVE_INFINITY;
  private stillFrames = 0;
  /** The rest of a camera that stopped just before the engine idled, due when no movement came for `REST.ms`. */
  private restTimer: ReturnType<typeof setTimeout> | undefined;
  /** The camera rests: the preset shows in full and frames are not judged. */
  private resting = false;

  constructor(
    private readonly target: QualityTarget,
    options: QualityOptions,
  ) {
    this.now = options.now ?? (() => globalThis.performance.now());
    this.governorOptions = typeof options.adaptive === 'object' ? options.adaptive : {};
    this.adaptive = options.adaptive !== false;
    this.pixelRatio = (options.hints ?? browserHints()).pixelRatio;
    ({ preset: this.preset, choice: this.choice } = startPreset(target, options));
    this.ladder = adaptiveLadder(QUALITY_PRESETS[this.preset]);
    this.governor = new FrameTimeGovernor(this.ladder.length, this.governorOptions);
    this.settings = resolve(QUALITY_PRESETS[this.preset], target.capabilities, this.pixelRatio);
    this.unsubscribe = [
      target.on('frame', () => this.frame()),
      target.on('idle', () => {
        this.governor.idle();
        this.restAfterIdle();
      }),
      target.on('movestart', () => this.move()),
      target.on('move', () => this.move()),
      target.on('moveend', () => this.move()),
    ];
    this.apply(0, 'start');
  }

  get level(): number {
    return this.governor.level;
  }

  private frame(): void {
    if (!this.adaptive || this.resting) return;
    const still = ++this.stillFrames >= REST.frames && this.now() - this.movedAtMs >= REST.ms;
    if (still && this.movedAtMs > Number.NEGATIVE_INFINITY) return this.rest();
    const decision = this.governor.frame(this.now());
    if (decision) this.apply(decision.level, decision.direction);
  }

  // A still view is drawn once, so its cost does not matter: it turns sharp the moment the camera stops.
  private rest(): void {
    if (this.resting || !this.adaptive) return;
    this.resting = true;
    if (this.governor.level > 0) this.apply(0, 'rest');
  }

  private restAfterIdle(): void {
    if (this.movedAtMs === Number.NEGATIVE_INFINITY || this.resting) return;
    const waitMs = REST.ms - (this.now() - this.movedAtMs);
    if (waitMs <= 0) return this.rest();
    clearTimeout(this.restTimer);
    this.restTimer = setTimeout(() => this.restAfterIdle(), waitMs);
  }

  private move(): void {
    this.movedAtMs = this.now();
    this.stillFrames = 0;
    clearTimeout(this.restTimer);
    if (!this.resting) return;
    this.resting = false;
    if (this.adaptive && this.governor.level > 0) this.apply(this.governor.level, 'motion');
  }

  private apply(level: number, reason: QualityChangeReason): void {
    this.settings = resolve(
      this.ladder[level] ?? QUALITY_PRESETS[this.preset],
      this.target.capabilities,
      this.pixelRatio,
    );
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
    clearTimeout(this.restTimer);
    for (const stop of this.unsubscribe) stop();
    this.handlers.clear();
  }
}

/**
 * Applies a quality preset to a globe and, unless `adaptive` is false, adapts it to the frame time (F399–F402): it
 * measures the interval between drawn frames, lowers one ladder step ({@link adaptiveLadder}) when frames stay slow
 * and raises one step back once they are fast for the governor's stable interval. The lowered level applies while the
 * camera moves: once it rests (the engine idles, or no movement event came for 150 ms while frames go on, as an
 * animation draws them, three frames at least) the preset shows in full, and the next movement brings the level back at once (F688). Create it after
 * `globe.ready`, so the 'auto' preset reads the device's capabilities; an explicit preset overrides detection.
 */
export function createQuality(target: QualityTarget, options: QualityOptions = {}): QualityController {
  return new Quality(target, options);
}
