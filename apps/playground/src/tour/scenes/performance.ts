// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** The Speed chapter: quality presets and the adaptive governor under an artificial GPU load; the diagnostics. */
import type { CameraMovement } from '@vibeglobe/core';
import { gpuLoad } from '@vibeglobe/renderer';
import { createDebugOverlay } from '@vibeglobe/ui';
import { createTileView } from '../../tile-view.js';
import type { Readout } from '../panel.js';
import type { SceneContext, SceneModule } from '../types.js';

/** Calls `show` with the mean frame time of the drawn frames, at most four times a second, only while frames draw. */
function frameTimes(context: SceneContext, show: (frameMs: number) => void): void {
  let lastMs = 0;
  let shownMs = 0;
  let sum = 0;
  let count = 0;
  context.on('frame', () => {
    const now = performance.now();
    if (lastMs > 0 && now - lastMs < 1000) {
      sum += now - lastMs;
      count++;
    }
    lastMs = now;
    if (now - shownMs < 250 || count === 0) return;
    show(sum / count);
    shownMs = now;
    sum = count = 0;
  });
}

/** Presets, the governor and a GPU load to provoke it. */
export const quality: SceneModule = {
  code: `import { createQuality } from '@vibeglobe/quality';

const quality = createQuality(globe, { preset: 'auto', adaptive: true });
quality.onChange(({ reason, level, settings }) => console.log(reason, level, settings.resolutionScale));
quality.setPreset('low');`,
  async start(context) {
    const { globe, panel } = context;
    const { createQuality } = await import('@vibeglobe/quality');
    const before = globe.qualitySettings;
    const controller = createQuality(globe, { preset: 'high', adaptive: true });
    let passes = 0;
    const removeLoad = globe.addRenderExtension(gpuLoad(() => passes));
    let orbit: CameraMovement | undefined;
    context.defer(() => {
      orbit?.cancel();
      removeLoad();
      controller.destroy();
      globe.setQualitySettings(before);
    });
    context.go({ longitudeDeg: 10, latitudeDeg: 44, zoom: 2.6, tiltDeg: 0, headingDeg: 0 });
    panel.choice(
      'Preset',
      [
        ['low', 'Low'],
        ['medium', 'Medium'],
        ['high', 'High'],
        ['ultra', 'Ultra'],
      ],
      'high',
      (preset) => controller.setPreset(preset),
    );
    panel.toggle('Adaptive quality', true, (on) => controller.setAdaptive(on));
    panel.slider(
      'Artificial GPU load',
      { min: 0, max: 40, step: 1, value: 0, format: (v) => `${String(v)} passes` },
      (v) => {
        passes = v;
        globe.requestRender();
      },
    );
    panel.buttons([
      'Keep the camera moving',
      () => void (orbit = globe.orbit({ degreesPerSecond: 15, signal: context.signal })),
    ]);
    const readout = panel.readout();
    let frameMs = 0;
    const show = (): void => {
      const s = controller.settings;
      readout([
        ['Preset · level', `${controller.preset} · ${String(controller.level)}`],
        ['Resolution scale', s.resolutionScale.toFixed(2)],
        ['Antialiasing', s.antialias],
        ['Atmosphere', s.atmosphere],
        ['Frame time', frameMs > 0 ? `${frameMs.toFixed(1)} ms` : '—'],
      ]);
    };
    context.defer(controller.onChange(show));
    frameTimes(context, (ms) => ((frameMs = ms), show()));
    show();
    panel.note(
      'With a load and the camera moving, the governor lowers the level; once the camera rests, the preset returns in full.',
    );
  },
};

/** The rows of the diagnostics readout, from the globe's counters. */
function counters(context: SceneContext, readout: Readout, frameMs: number): void {
  const { globe } = context;
  const caps = globe.capabilities;
  const stats = globe.rendererStats();
  const imagery = globe.imageryStats();
  readout([
    ['Backend', `${caps?.backend ?? '—'} · ${caps?.depthPath ?? ''}`],
    ['Frame time', frameMs > 0 ? `${frameMs.toFixed(1)} ms` : '—'],
    ['Draw calls', String(stats.drawCalls)],
    ['Triangles', stats.triangles.toLocaleString('en')],
    ['Surface tiles', String(globe.surfaceTiles().length)],
    ['Imagery tiles', imagery ? `${String(imagery.ready)} ready · ${String(imagery.loading)} loading` : '—'],
    ['Max texture', String(caps?.maxTextureSize ?? '—')],
  ]);
}

/** The HUD, the debug panel, the tile view and the engine's counters. */
export const diagnostics: SceneModule = {
  code: `import { createDebugOverlay } from '@vibeglobe/ui';

globe.diagnostics.setPhaseTiming(true); // per-phase costs of each frame
console.log(globe.diagnostics.phaseTimesMs(), globe.rendererStats().drawCalls);
const overlay = createDebugOverlay(container);
globe.on('frame', () => overlay.update({ frameTimeMs, framesPerSecond }));`,
  start(context) {
    const { globe, panel, container } = context;
    const hud = window.vibeglobePlayground?.showHud;
    const tileView = createTileView(globe, container, undefined);
    let overlay: ReturnType<typeof createDebugOverlay> | undefined;
    context.defer(() => {
      hud?.(false);
      tileView(false);
      overlay?.destroy();
    });
    context.go({ longitudeDeg: 9.5, latitudeDeg: 45.5, zoom: 4.8, tiltDeg: 0, headingDeg: 0 });
    if (hud) panel.toggle('Performance HUD', false, hud);
    panel.toggle('Tile view', false, tileView);
    panel.toggle('Debug panel', false, (on) => {
      overlay?.destroy();
      overlay = on ? createDebugOverlay(container) : undefined;
    });
    const readout = panel.readout();
    let frameMs = 0;
    frameTimes(context, (ms) => {
      frameMs = ms;
      overlay?.update({ frameTimeMs: ms, framesPerSecond: 1000 / ms });
      counters(context, readout, frameMs);
    });
    counters(context, readout, frameMs);
    panel.note('Every counter is read when a frame is drawn: a still view draws nothing and costs nothing.');
  },
};
