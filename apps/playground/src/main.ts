import { WGS84 } from '@vibeglobe/core';
import { startFrameLoop } from './frame-loop.js';

const OVERLAY_REFRESH_MS = 250;

const params = new URLSearchParams(location.search);
const app = document.querySelector<HTMLDivElement>('#app');
const status = document.querySelector<HTMLParagraphElement>('#status');
if (status) {
  status.textContent = `Engine bootstrap pending (milestone 2). Reference ellipsoid: WGS84, a = ${WGS84.semiMajorAxisMeters} m.`;
}

if (app && params.has('debug')) {
  // Loaded on demand so the overlay code is not part of the default page.
  const { createDebugOverlay } = await import('@vibeglobe/ui');
  const overlay = createDebugOverlay(app);
  let lastRefreshMs = -Infinity;
  startFrameLoop((stats, timestampMs) => {
    if (timestampMs - lastRefreshMs < OVERLAY_REFRESH_MS) return;
    lastRefreshMs = timestampMs;
    overlay.update({ frameTimeMs: stats.meanFrameTimeMs, framesPerSecond: stats.framesPerSecond });
  });
} else if (params.get('scenario') === 'frame-loop') {
  startFrameLoop(() => undefined);
}
