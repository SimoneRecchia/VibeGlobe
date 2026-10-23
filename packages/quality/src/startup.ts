import type { RendererCapabilities } from '@vibeglobe/core';
import type { QualityPresetName } from './presets.js';

/** Device hints beyond the renderer's capabilities; browsers give them through `navigator` and `matchMedia`. */
export interface DeviceHints {
  /** Logical processors (`navigator.hardwareConcurrency`). */
  readonly hardwareConcurrency?: number;
  /** A coarse pointer is the primary input (`matchMedia('(pointer: coarse)')`): phones and tablets. */
  readonly coarsePointer?: boolean;
  /** Device pixel ratio. */
  readonly pixelRatio?: number;
}

/** The capabilities the choice reads: `Globe.capabilities` (after `ready`). */
export type CapabilityProfile = Pick<
  RendererCapabilities,
  'backend' | 'maxTextureSize' | 'maxAnisotropy' | 'deviceMemoryGiB' | 'adapter'
>;

/** The chosen preset and the rule that chose it. */
export interface PresetChoice {
  readonly preset: QualityPresetName;
  readonly reason: string;
}

const SOFTWARE_ADAPTER = /swiftshader|llvmpipe|softpipe|software|microsoft basic render/i;

/**
 * Picks the start-up preset from capability detection (F400). The rules, first match wins:
 *
 * 1. `low`: a software rasterizer (SwiftShader, llvmpipe), at most 2 GiB of device memory, a largest texture under
 *    4096 texels, or at most 2 processors;
 * 2. `medium`: the WebGL2 fallback, at most 4 GiB of memory, at most 4 processors, or a coarse pointer (phones and
 *    tablets: the reference tablet lands here);
 * 3. `high`: everything else (the reference desktop).
 *
 * `ultra` is never chosen automatically; applications pass it explicitly. Unknown hints (a browser without
 * `navigator.deviceMemory`) count as neither weak nor strong.
 */
export function choosePreset(capabilities: CapabilityProfile, hints: DeviceHints = {}): PresetChoice {
  const memory = capabilities.deviceMemoryGiB;
  const cores = hints.hardwareConcurrency;
  if (SOFTWARE_ADAPTER.test(capabilities.adapter))
    return { preset: 'low', reason: `software renderer (${capabilities.adapter})` };
  if (memory !== undefined && memory <= 2) return { preset: 'low', reason: `${memory} GiB of device memory` };
  if (capabilities.maxTextureSize < 4096)
    return { preset: 'low', reason: `largest texture ${capabilities.maxTextureSize}` };
  if (cores !== undefined && cores <= 2) return { preset: 'low', reason: `${cores} processors` };
  if (capabilities.backend === 'webgl2') return { preset: 'medium', reason: 'WebGL2 fallback' };
  if (memory !== undefined && memory <= 4) return { preset: 'medium', reason: `${memory} GiB of device memory` };
  if (cores !== undefined && cores <= 4) return { preset: 'medium', reason: `${cores} processors` };
  if (hints.coarsePointer === true) return { preset: 'medium', reason: 'touch device' };
  return { preset: 'high', reason: 'capable WebGPU device' };
}

/** Reads {@link DeviceHints} from a browser's `navigator` and `matchMedia`, when they exist (never at import time). */
export function browserHints(): DeviceHints {
  const scope = globalThis as {
    navigator?: { hardwareConcurrency?: number };
    matchMedia?: (query: string) => { matches: boolean };
    devicePixelRatio?: number;
  };
  return {
    ...(typeof scope.navigator?.hardwareConcurrency === 'number'
      ? { hardwareConcurrency: scope.navigator.hardwareConcurrency }
      : {}),
    ...(typeof scope.matchMedia === 'function' ? { coarsePointer: scope.matchMedia('(pointer: coarse)').matches } : {}),
    ...(typeof scope.devicePixelRatio === 'number' ? { pixelRatio: scope.devicePixelRatio } : {}),
  };
}
