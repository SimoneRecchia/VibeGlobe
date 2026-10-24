// Quality presets, adaptive quality and the atmosphere in the playground (M11, hook C (4) of the models and quality
// track): loaded only when one of their URL parameters is present.
//
// - `?quality=low|medium|high|ultra|auto` applies @vibeglobe/quality's presets (`auto` picks one from the device);
//   `?qualityAdaptive=0` keeps the preset fixed (adaptive quality is on otherwise), `?governor={...}` tunes it.
// - `?gpuLoad=N` (debug) draws N extra full-screen passes per frame: an artificial GPU load (F401).
// - `?atmosphere=off|low|medium|high|ultra` sets the atmosphere level, `?fog=0` turns its haze off, `?sun=<ISO time>`
//   lights the globe by the Sun at that time, `?haze=<factor>` sets the aerosol density (F391–F396).
import type { AtmosphereLevel, Globe } from '@vibeglobe/core';
import type { GovernorOptions, QualityChange, QualityController, QualityPresetName } from '@vibeglobe/quality';
import { gpuLoad } from '@vibeglobe/renderer';

/** One drawn frame: its measured duration (wall clock between frames), the drawing buffer and the applied level. */
interface QualityFrame {
  readonly frameNumber: number;
  readonly frameMs: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly level: number;
}

/** The test hooks of this module (`window.vibeglobeQuality`). */
export interface QualityHooks {
  readonly quality: QualityController | undefined;
  readonly changes: QualityChange[];
  readonly frames: QualityFrame[];
  /** Sets the artificial GPU load, in extra full-screen passes per frame. */
  setGpuLoad(passes: number): void;
}

declare global {
  interface Window {
    vibeglobeQuality?: QualityHooks;
  }
}

const LEVELS: readonly AtmosphereLevel[] = ['off', 'low', 'medium', 'high', 'ultra'];

/** Applies the URL's quality and atmosphere parameters to a ready globe and exposes the test hooks. */
export async function startQuality(globe: Globe, params: URLSearchParams, canvas: HTMLCanvasElement): Promise<void> {
  const level = params.get('atmosphere');
  if (level !== null && LEVELS.includes(level as AtmosphereLevel))
    globe.setQualitySettings({ atmosphere: level as AtmosphereLevel, fog: params.get('fog') !== '0' });
  const sun = params.get('sun');
  globe.setAtmosphere({
    ...(sun !== null ? { sunLighting: true, timeMs: Date.parse(sun) } : {}),
    ...(params.has('haze') ? { haze: Number(params.get('haze')) } : {}),
  });
  let passes = Number(params.get('gpuLoad') ?? 0);
  globe.addRenderExtension(gpuLoad(() => passes));
  const changes: QualityChange[] = [];
  const frames: QualityFrame[] = [];
  let quality: QualityController | undefined;
  const preset = params.get('quality');
  if (preset !== null) {
    const { createQuality } = await import('@vibeglobe/quality');
    quality = createQuality(globe, {
      preset: preset as QualityPresetName | 'auto',
      adaptive:
        params.get('qualityAdaptive') === '0' ? false : (JSON.parse(params.get('governor') ?? '{}') as GovernorOptions),
    });
    quality.onChange((change) => changes.push(change));
  }
  let last = performance.now();
  globe.on('frame', ({ frameNumber }) => {
    const now = performance.now();
    frames.push({
      frameNumber,
      frameMs: now - last,
      widthPx: canvas.width,
      heightPx: canvas.height,
      level: quality?.level ?? 0,
    });
    if (frames.length > 2000) frames.shift();
    last = now;
  });
  window.vibeglobeQuality = {
    quality,
    changes,
    frames,
    setGpuLoad(count) {
      passes = count;
      globe.requestRender();
    },
  };
}
