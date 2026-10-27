// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
// The playground's debug overlay (`?debug=1`, F086, F087, F097, F098, F103, F116): frame rate, device, sources, the
// surface and cache rows, the rows of the running scenario and, with `?network=`, of the offline engine's tiers.
import type { Globe } from '@vibeglobe/core';
import { startFrameLoop, type FrameLoop } from './frame-loop.js';
import type { PlaygroundOffline } from './offline-demo.js';
import { cacheLine, surfaceLine } from './overlay-lines.js';
import { sourceLines } from './source-lines.js';

/** How often the overlay's rows refresh. */
const OVERLAY_REFRESH_MS = 250;

export async function startDebugOverlay(
  globe: Globe,
  host: HTMLElement,
  params: URLSearchParams,
  offlineDemo: PlaygroundOffline | undefined,
): Promise<FrameLoop> {
  // Loaded on demand so the overlay code is not part of the default page.
  const [{ createDebugOverlay }, { addTileViewToggle }] = await Promise.all([
    import('@vibeglobe/ui'),
    import('./tile-view.js'),
  ]);
  const overlay = createDebugOverlay(host);
  const offlineRows = offlineDemo
    ? (await import('./offline-demo.js')).tierRows.bind(undefined, offlineDemo.offline)
    : undefined;
  addTileViewToggle(globe, host, params.has('imagery') ? `fixture-${params.get('imagery')}` : undefined);
  let info: (readonly [string, string])[] = [];
  let pipelineCompiles = -1;
  let surfaceInfo = '';
  // Read at start and again after a recovery, which may have switched the backend (KB-049).
  const readInfo = (): void => {
    const caps = globe.capabilities;
    if (!caps) return;
    pipelineCompiles = Number.NaN;
    info = [
      ['backend', `backend ${caps.backend}`],
      ['max-texture-size', `max texture ${caps.maxTextureSize}`],
      ['max-anisotropy', `anisotropy ${caps.maxAnisotropy}`],
      ['compressed-formats', `compressed ${caps.compressedTextureFormats.join(', ') || 'none'}`],
      ['device-memory', `memory ${caps.deviceMemoryGiB === undefined ? 'unknown' : `${caps.deviceMemoryGiB} GiB`}`],
      ['adapter', `adapter ${caps.adapter}`],
      ['depth', `depth ${caps.depthPath} ${caps.depthFormat}`],
      ...sourceLines(globe),
    ];
  };
  void globe.ready.then(readInfo);
  globe.on('device-restored', readInfo);
  let lastRefreshMs = -Infinity;
  return startFrameLoop((stats, timestampMs) => {
    if (timestampMs - lastRefreshMs < OVERLAY_REFRESH_MS) return;
    lastRefreshMs = timestampMs;
    overlay.update({ frameTimeMs: stats.meanFrameTimeMs, framesPerSecond: stats.framesPerSecond });
    // Pipelines compiled after the warm-up stay 0 in normal use (ADR 0010 §4).
    const rendererStats = globe.rendererStats();
    const compiles = info.length > 0 ? rendererStats.pipelineCompiles : -1;
    // Draw calls and pipeline changes of the last frame (F103).
    const draws = `draw calls ${rendererStats.drawCalls} · pipeline switches ${rendererStats.pipelineSwitches}`;
    const surface = surfaceLine(globe);
    const imagery = globe.imageryStats();
    const cache = imagery ? cacheLine(imagery) : '';
    // Rows of the running scenario (F374) and of the offline engine's tiers (`?network=`, F272).
    const extra = [...(window.vibeglobeDebugRows?.() ?? []), ...(offlineRows?.(globe) ?? [])];
    if (compiles === pipelineCompiles && surface + cache + draws + extra.join() === surfaceInfo) return;
    pipelineCompiles = compiles;
    surfaceInfo = surface + cache + draws + extra.join();
    overlay.setInfo([
      ...info,
      ['pipeline-compiles', `pipelines after warm-up ${compiles}`],
      ['draws', draws],
      ['surface', surface],
      ...(imagery ? ([['cache', cache]] as [string, string][]) : []),
      ...extra,
    ]);
  });
}
