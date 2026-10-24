// The 3D Tiles city tour (F471, track E hook 5): `?scenario=3dtiles-city&tour=1` moves the camera over the fixture
// city without end, for the `3dtiles-city` benchmark: it circles the city's center, the zoom and tilt swinging slowly,
// one step per display frame, as the scripted navigation of e2e/tiles3d-performance.spec.ts pans, zooms, rotates and
// tilts.
import type { Globe } from '@vibeglobe/core';

/** Meters per degree of latitude. */
const METERS_PER_DEG = 111_320;
/** The circle's radius around the city's center, meters. */
const RADIUS_M = 300;
/** One lap, milliseconds. */
const LAP_MS = 20_000;

/** The `3dtiles-*` scenarios (`tiles3d-demo.ts`), and with `&tour=1` the tour once the tileset is added. */
export async function showTiles3D(globe: Globe, app: HTMLElement, params: URLSearchParams): Promise<void> {
  await (await import('./tiles3d-demo.js')).showTiles3DScenario(globe, app, params);
  if (params.get('tour') === '1') startCityTour(globe);
}

/** Starts the tour about the camera's current target; it runs until the page closes. */
function startCityTour(globe: Globe): void {
  const { longitudeDeg, latitudeDeg } = globe.camera;
  const metersPerDegLon = METERS_PER_DEG * Math.cos((latitudeDeg * Math.PI) / 180);
  const startMs = performance.now();
  const step = (): void => {
    const phase = (((performance.now() - startMs) % LAP_MS) / LAP_MS) * 2 * Math.PI;
    void globe.jumpTo({
      longitudeDeg: longitudeDeg + (RADIUS_M * Math.cos(phase)) / metersPerDegLon,
      latitudeDeg: latitudeDeg + (RADIUS_M * Math.sin(phase)) / METERS_PER_DEG,
      zoom: 17.25 + 0.75 * Math.sin(2 * phase),
      tiltDeg: 40 + 15 * Math.sin(3 * phase),
      headingDeg: (phase * 180) / Math.PI,
    });
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
