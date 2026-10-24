// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** Names of the quality presets (F399), from the cheapest to the most detailed. */
export type QualityPresetName = 'low' | 'medium' | 'high' | 'ultra';

/** Preset names in order of cost. */
export const PRESET_NAMES: readonly QualityPresetName[] = Object.freeze(['low', 'medium', 'high', 'ultra']);

/** Anti-aliasing modes, cheapest first. */
export type AntialiasMode = 'none' | 'fxaa' | 'msaa4';

/** Atmosphere ray-marching levels (ADR 0040's `ATMOSPHERE_QUALITY`), or no atmosphere at all. */
export type AtmosphereLevel = 'off' | 'low' | 'medium' | 'high' | 'ultra';

/** What a quality level sets: level of detail, resolution scale and effects (PLAN.md, "Quality presets"). */
export interface QualitySettings {
  /** Multiplier of the device pixel ratio for the drawing buffer (`Globe.setResolutionScale`). */
  readonly resolutionScale: number;
  /** Largest projected geometric error before a tile refines, CSS pixels: larger means coarser tiles, fewer draws. */
  readonly maxScreenErrorPx: number;
  /** Anisotropic filtering level; 'max' is the device's maximum (F398). */
  readonly anisotropy: number | 'max';
  readonly antialias: AntialiasMode;
  readonly atmosphere: AtmosphereLevel;
  /** Distance fog and haze over the surface (ADR 0040). */
  readonly fog: boolean;
}

/**
 * The presets (F399). Each step up costs more GPU time: more pixels (resolution scale), finer tiles (screen error),
 * sharper tilted imagery (anisotropy), smoother edges (anti-aliasing) and more atmosphere samples. `low` keeps the
 * view legible on weak devices; `ultra` is never chosen automatically (it spends power for a small gain).
 */
export const QUALITY_PRESETS: Readonly<Record<QualityPresetName, QualitySettings>> = Object.freeze({
  low: Object.freeze({
    resolutionScale: 0.5,
    maxScreenErrorPx: 4,
    anisotropy: 1,
    antialias: 'none',
    atmosphere: 'low',
    fog: false,
  }),
  medium: Object.freeze({
    resolutionScale: 0.75,
    maxScreenErrorPx: 2,
    anisotropy: 4,
    antialias: 'fxaa',
    atmosphere: 'medium',
    fog: true,
  }),
  high: Object.freeze({
    resolutionScale: 1,
    maxScreenErrorPx: 1,
    anisotropy: 'max',
    antialias: 'msaa4',
    atmosphere: 'high',
    fog: true,
  }),
  ultra: Object.freeze({
    resolutionScale: 1.25,
    maxScreenErrorPx: 0.75,
    anisotropy: 'max',
    antialias: 'msaa4',
    atmosphere: 'ultra',
    fog: true,
  }),
} satisfies Record<QualityPresetName, QualitySettings>);

/** True for a preset name. */
export function isPresetName(value: unknown): value is QualityPresetName {
  return typeof value === 'string' && (PRESET_NAMES as readonly string[]).includes(value);
}

/** Lowest resolution scale adaptive quality goes to. */
export const MIN_ADAPTIVE_RESOLUTION_SCALE = 0.4;
/** Coarsest screen error adaptive quality goes to, in CSS pixels. */
export const MAX_ADAPTIVE_SCREEN_ERROR_PX = 8;

/**
 * The adaptive ladder of a preset (F401, F402): step 0 is the preset; each further step lowers one setting a little,
 * alternating between resolution (×0.85) and level of detail (screen error ×1.4), so no single step changes the view
 * much (no visible pop). Effects are not touched: they cost little next to pixels and tiles, and switching them off
 * would show. The ladder stops at {@link MIN_ADAPTIVE_RESOLUTION_SCALE} and {@link MAX_ADAPTIVE_SCREEN_ERROR_PX}.
 */
export function adaptiveLadder(preset: QualitySettings): QualitySettings[] {
  const ladder: QualitySettings[] = [preset];
  let current = preset;
  for (let step = 0; step < 16; step++) {
    const lowerResolution = step % 2 === 0;
    const next = lowerResolution
      ? { ...current, resolutionScale: Math.max(round(current.resolutionScale * 0.85), MIN_ADAPTIVE_RESOLUTION_SCALE) }
      : { ...current, maxScreenErrorPx: Math.min(round(current.maxScreenErrorPx * 1.4), MAX_ADAPTIVE_SCREEN_ERROR_PX) };
    if (next.resolutionScale === current.resolutionScale && next.maxScreenErrorPx === current.maxScreenErrorPx) {
      if (
        current.resolutionScale <= MIN_ADAPTIVE_RESOLUTION_SCALE &&
        current.maxScreenErrorPx >= MAX_ADAPTIVE_SCREEN_ERROR_PX
      )
        break;
      continue;
    }
    ladder.push(next);
    current = next;
  }
  return ladder;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
