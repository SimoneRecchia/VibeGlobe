// The quality harness page (e2e/support/quality.html): a globe orbiting over the base imagery with @vibeglobe/quality
// applied, driven by e2e/quality.spec.ts through `window.qualityHarness`. Public API only.
//
// Frame times are synthetic and deterministic: each drawn frame advances the governor's clock by
// `baseMs + loadMsPerMegapixel × drawing-buffer megapixels`, an emulated fill-bound GPU load that the resolution scale
// really relieves (the drawing buffer is the canvas's actual size). The engine itself runs on a manual clock.
import { createGlobe, type Globe } from '@vibeglobe/core';
import {
  createQuality,
  type GovernorOptions,
  type QualityChange,
  type QualityController,
  type QualityPresetName,
} from '@vibeglobe/quality';
import { createRenderer } from '@vibeglobe/renderer';

/** One drawn frame: its synthetic duration, the drawing buffer and the applied level. */
export interface QualityFrame {
  readonly frameNumber: number;
  readonly frameMs: number;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly level: number;
}

/** A captured frame summarized in the page: pixels that are black or not drawn, and the mean luminance. */
export interface FrameSample {
  readonly frameNumber: number;
  readonly emptyPixels: number;
  readonly meanLuminance: number;
}

/** The page's test hooks. */
interface QualityHarness {
  readonly globe: Globe;
  readonly quality: QualityController;
  readonly changes: QualityChange[];
  readonly frames: QualityFrame[];
  /** Sets the injected load, in synthetic milliseconds per drawing-buffer megapixel. */
  setLoad(msPerMegapixel: number): void;
  /** Captures the next frame and summarizes it. */
  sample(): Promise<FrameSample>;
}

declare global {
  interface Window {
    qualityHarness?: QualityHarness;
  }
}

/** Emulated capability profiles (F400): the renderer's own capabilities with these fields replaced. */
const PROFILES = {
  'low-end': { deviceMemoryGiB: 2, maxTextureSize: 4096, backend: 'webgl2', adapter: 'Emulated low-end GPU' },
  'high-end': { deviceMemoryGiB: 16, maxTextureSize: 16384, backend: 'webgpu', adapter: 'Emulated high-end GPU' },
} as const;

const params = new URLSearchParams(location.search);
const container = document.querySelector<HTMLDivElement>('#app');
const canvas = document.querySelector<HTMLCanvasElement>('#globe');
if (!container || !canvas) throw new Error('The harness page lost its map');
const backend = params.get('backend');
const globe = createGlobe({
  container,
  renderer: createRenderer({ backend: backend === 'webgpu' || backend === 'webgl2' ? backend : 'auto', canvas }),
  baseImageryUrl: '/imagery/natural-earth-4096.jpg',
  // Close enough that the globe fills the canvas: any black or undrawn pixel is a defect.
  view: { longitudeDeg: 10, latitudeDeg: 45, zoom: 5 },
  manualClockStepMs: 16,
});
await globe.ready;

const BASE_MS = 6;
let loadMsPerMegapixel = 0;
let clockMs = 0;
let lastFrameMs = 0;
// Registered before the controller's listener, so its clock reading sees this frame's duration.
globe.on('frame', () => {
  lastFrameMs = BASE_MS + (loadMsPerMegapixel * canvas.width * canvas.height) / 1e6;
  clockMs += lastFrameMs;
});
const profile = PROFILES[params.get('profile') as keyof typeof PROFILES] as
  (typeof PROFILES)[keyof typeof PROFILES] | undefined;
const capabilities = globe.capabilities && profile ? { ...globe.capabilities, ...profile } : globe.capabilities;
const preset = (params.get('quality') ?? 'auto') as QualityPresetName | 'auto';
const changes: QualityChange[] = [];
const quality = createQuality(
  {
    capabilities,
    on: (event, handler) => globe.on(event, handler),
    setResolutionScale: (scale) => globe.setResolutionScale(scale),
    requestRender: () => globe.requestRender(),
    // Level of detail and effects too (hook C (3)), except the atmosphere: on the software GPU of the test browsers it
    // slows real frames about sixfold, and the synthetic clock with them. The playground's quality page applies it
    // (e2e/quality-playground.spec.ts).
    setQualitySettings: (settings) => globe.setQualitySettings({ ...settings, atmosphere: 'off' }),
  },
  {
    preset,
    // `?governor={...}` tunes the governor (shorter intervals keep browser runs short); `?adaptive=0` turns it off.
    adaptive: params.get('adaptive') === '0' ? false : (JSON.parse(params.get('governor') ?? '{}') as GovernorOptions),
    now: () => clockMs,
    hints: { hardwareConcurrency: 8, coarsePointer: false },
  },
);
quality.onChange((change) => changes.push(change));
const frames: QualityFrame[] = [];
globe.on('frame', ({ frameNumber }) => {
  frames.push({
    frameNumber,
    frameMs: lastFrameMs,
    widthPx: canvas.width,
    heightPx: canvas.height,
    level: quality.level,
  });
});
// The camera keeps moving, so frames keep coming.
void globe.orbit({ degreesPerSecond: 30 });

window.qualityHarness = {
  globe,
  quality,
  changes,
  frames,
  setLoad(msPerMegapixel) {
    loadMsPerMegapixel = msPerMegapixel;
  },
  async sample() {
    const capture = await globe.captureFrame();
    const { rgba, widthPx, heightPx } = capture;
    let empty = 0;
    let luminance = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      const r = rgba[i] ?? 0;
      const g = rgba[i + 1] ?? 0;
      const b = rgba[i + 2] ?? 0;
      if ((rgba[i + 3] ?? 0) < 255 || r + g + b < 15) empty++;
      luminance += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    return { frameNumber: globe.frameNumber, emptyPixels: empty, meanLuminance: luminance / (widthPx * heightPx) };
  },
};
