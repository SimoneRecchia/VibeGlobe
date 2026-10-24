import { GlobeError } from './errors.js';
import type { AtmosphereSettings, QualitySettings, RendererQuality } from './quality-types.js';
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

  constructor(
    private readonly parts: QualityParts,
    initial: { quality?: unknown; atmosphere?: unknown; maxScreenErrorPx?: number },
  ) {
    const quality = validateQuality(initial.quality ?? {});
    this.quality = {
      maxScreenErrorPx: initial.maxScreenErrorPx ?? 1,
      anisotropy: quality.anisotropy ?? 64,
      antialias: quality.antialias ?? 'none',
      atmosphere: quality.atmosphere ?? 'off',
      fog: quality.fog ?? true,
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
    return { ...this.quality, resolutionScale: this.parts.resolutionScale() };
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
    const on = this.quality.atmosphere !== 'off' && this.quality.fog;
    this.parts.surface().setFog(on ? this.sky.haze : undefined);
  }

  private rendererQuality(renderer: RendererBackend): RendererQuality {
    const { anisotropy, antialias, atmosphere, fog } = this.quality;
    return { anisotropy: Math.min(anisotropy, renderer.capabilities.maxAnisotropy), antialias, atmosphere, fog };
  }
}
