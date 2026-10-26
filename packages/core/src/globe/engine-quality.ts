// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { GlobeError } from './errors.js';
import type { AtmosphereSettings, QualitySettings, RendererQuality } from './quality-types.js';
import { DEFAULT_CAP_COLORS, hexRgb, type PolarCapColors } from './polar-caps.js';
import type { Globe, RendererBackend } from './types.js';

/** The default time of the Sun: the June solstice of 2026 at noon UTC, as ADR 0040's harness. */
const DEFAULT_SUN_TIME_MS = Date.UTC(2026, 5, 21, 12);

/** A field's rule: a number range, a list of choices, or a boolean (`true`). */
type Rule = readonly [number, number] | readonly string[] | true;

const QUALITY_RULES: Readonly<Record<keyof QualitySettings, Rule>> = {
  resolutionScale: [0.1, 4],
  maxScreenErrorPx: [0.1, 64],
  anisotropy: [1, 64],
  antialias: ['none', 'fxaa', 'msaa4'],
  atmosphere: ['off', 'low', 'medium', 'high', 'ultra'],
  fog: true,
  fogAwareDetail: true,
};

const ATMOSPHERE_RULES: Readonly<Record<keyof AtmosphereSettings, Rule>> = {
  sunLighting: true,
  timeMs: [-8.64e15, 8.64e15],
  haze: [0, 10],
};

/** Validates settings at the API boundary against `rules`; throws 'invalid-option' naming the field. */
function validate<T>(what: string, settings: unknown, rules: Readonly<Record<string, Rule>>): T {
  if (settings === null || typeof settings !== 'object')
    throw new GlobeError('invalid-option', `${what} must be an object, got ${String(settings)}`);
  for (const [name, rule] of Object.entries(rules)) {
    const value = (settings as Record<string, unknown>)[name];
    if (value === undefined) continue;
    const ok =
      rule === true
        ? typeof value === 'boolean'
        : typeof rule[0] === 'number'
          ? typeof value === 'number' && value >= rule[0] && value <= (rule[1] as number)
          : (rule as readonly string[]).includes(value as string);
    const expected =
      rule === true ? 'true or false' : typeof rule[0] === 'number' ? rule.join(' to ') : rule.join(', ');
    if (!ok) throw new GlobeError('invalid-option', `${name} must be ${expected}, got ${JSON.stringify(value)}`);
  }
  return settings as T;
}

const validateQuality = (settings: unknown): QualitySettings => validate('quality settings', settings, QUALITY_RULES);
const validateAtmosphere = (settings: unknown): AtmosphereSettings =>
  validate('atmosphere settings', settings, ATMOSPHERE_RULES);

/** What {@link EngineQuality} changes outside itself, read when used. */
export interface QualityParts {
  readonly globe: Pick<Globe, 'setResolutionScale' | 'requestRender'>;
  renderer(): RendererBackend | undefined;
  surface(): { setScreenError(maxScreenErrorPx: number): void; setFog(haze: number | undefined): void };
  resolutionScale(): number;
}

/** `Globe.qualitySettings` and `Globe.atmosphere`, applied to the surface selection and the renderer (F399, ADR 0122). */
export class EngineQuality {
  private quality: Omit<Required<QualitySettings>, 'resolutionScale'>;
  private sky: Required<AtmosphereSettings>;
  private caps: Required<PolarCapColors> = DEFAULT_CAP_COLORS;

  constructor(
    private readonly parts: QualityParts,
    initial: { quality?: unknown; atmosphere?: unknown; maxScreenErrorPx?: number; polarCapColors?: unknown },
  ) {
    if (initial.polarCapColors !== undefined) this.validateCaps(initial.polarCapColors);
    const quality = validateQuality(initial.quality ?? {});
    this.quality = {
      maxScreenErrorPx: initial.maxScreenErrorPx ?? 1,
      anisotropy: quality.anisotropy ?? 64,
      antialias: quality.antialias ?? 'msaa4',
      atmosphere: quality.atmosphere ?? 'off',
      fog: quality.fog ?? true,
      fogAwareDetail: quality.fogAwareDetail ?? true,
    };
    this.sky = {
      sunLighting: false,
      timeMs: DEFAULT_SUN_TIME_MS,
      haze: 1,
      ...validateAtmosphere(initial.atmosphere ?? {}),
    };
    this.applyFog();
  }

  /** The quality settings in effect. */
  get settings(): Required<QualitySettings> {
    // The anisotropy applied: the device's maximum caps the level asked for (F398).
    const max = this.parts.renderer()?.capabilities.maxAnisotropy;
    const anisotropy = max === undefined ? this.quality.anisotropy : Math.min(this.quality.anisotropy, max);
    return { ...this.quality, anisotropy, resolutionScale: this.parts.resolutionScale() };
  }

  /** The atmosphere's scene settings in effect. */
  get atmosphere(): Required<AtmosphereSettings> {
    return { ...this.sky };
  }

  /** Applies everything to a renderer that just started. */
  attach(renderer: RendererBackend): void {
    const globe = this.parts.globe;
    void renderer.setQuality?.(this.rendererQuality(renderer))?.then(() => globe.requestRender());
    renderer.setAtmosphere?.(this.sky);
    this.applyCaps(renderer);
  }

  /** Validates and applies the polar caps' fill colors; fields not given keep their value. */
  setCaps(colors: PolarCapColors): void {
    this.validateCaps(colors);
    this.applyCaps(this.parts.renderer());
    this.parts.globe.requestRender();
  }

  private validateCaps(colors: unknown): void {
    if (colors === null || typeof colors !== 'object')
      throw new GlobeError('invalid-option', `polarCapColors must be an object, got ${String(colors)}`);
    const { north, south } = colors as PolarCapColors;
    if (north !== undefined) hexRgb('polarCapColors.north', north);
    if (south !== undefined) hexRgb('polarCapColors.south', south);
    this.caps = { north: north ?? this.caps.north, south: south ?? this.caps.south };
  }

  private applyCaps(renderer: RendererBackend | undefined): void {
    renderer?.setPolarCapColors?.(hexRgb('north', this.caps.north), hexRgb('south', this.caps.south));
  }

  /** Validates and applies quality settings; fields not given keep their value. */
  set(settings: QualitySettings): void {
    const { resolutionScale, ...rest } = validateQuality(settings);
    this.quality = { ...this.quality, ...rest };
    if (rest.maxScreenErrorPx !== undefined) this.parts.surface().setScreenError(rest.maxScreenErrorPx);
    if (resolutionScale !== undefined) this.parts.globe.setResolutionScale(resolutionScale);
    this.applyFog();
    const renderer = this.parts.renderer();
    const applied = renderer?.setQuality?.(this.rendererQuality(renderer));
    const globe = this.parts.globe;
    globe.requestRender();
    void applied?.then(() => globe.requestRender());
  }

  /** Validates and applies atmosphere settings; fields not given keep their value. */
  setAtmosphere(settings: AtmosphereSettings): void {
    this.sky = { ...this.sky, ...validateAtmosphere(settings) };
    this.parts.renderer()?.setAtmosphere?.(this.sky);
    this.applyFog();
    this.parts.globe.requestRender();
  }

  /** Fog-aware detail (F395) follows the fog the renderer draws: on while the atmosphere and its fog are. */
  private applyFog(): void {
    const { atmosphere, fog, fogAwareDetail } = this.quality;
    const on = atmosphere !== 'off' && fog && fogAwareDetail;
    this.parts.surface().setFog(on ? this.sky.haze : undefined);
  }

  private rendererQuality(renderer: RendererBackend): RendererQuality {
    const { anisotropy, antialias, atmosphere, fog } = this.quality;
    return { anisotropy: Math.min(anisotropy, renderer.capabilities.maxAnisotropy), antialias, atmosphere, fog };
  }
}
