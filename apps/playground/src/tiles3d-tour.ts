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

/** The `3dtiles-*` scenarios (`tiles3d-demo.ts`); the tour is the page's measured loop (`cityTour`). */
export async function showTiles3D(globe: Globe, app: HTMLElement, params: URLSearchParams): Promise<void> {
  await (await import('./tiles3d-demo.js')).showTiles3DScenario(globe, app, params);
}

/**
 * One step of the tour per call, about the camera's target once the scenario is `shown` (the city's center, which it
 * frames): it runs until the page closes, driven by `startMeasuredLoop`, so the benchmark samples the engine's CPU time.
 */
export function cityTour(globe: Globe, shown: Promise<unknown>): () => boolean {
  let start: { longitudeDeg: number; latitudeDeg: number; metersPerDegLon: number; startMs: number } | undefined;
  let framed = false;
  void shown.then(() => (framed = true));
  return () => {
    if (!framed) return false;
    start ??= {
      longitudeDeg: globe.camera.longitudeDeg,
      latitudeDeg: globe.camera.latitudeDeg,
      metersPerDegLon: METERS_PER_DEG * Math.cos((globe.camera.latitudeDeg * Math.PI) / 180),
      startMs: performance.now(),
    };
    const phase = (((performance.now() - start.startMs) % LAP_MS) / LAP_MS) * 2 * Math.PI;
    void globe.jumpTo({
      longitudeDeg: start.longitudeDeg + (RADIUS_M * Math.cos(phase)) / start.metersPerDegLon,
      latitudeDeg: start.latitudeDeg + (RADIUS_M * Math.sin(phase)) / METERS_PER_DEG,
      zoom: 17.25 + 0.75 * Math.sin(2 * phase),
      tiltDeg: 40 + 15 * Math.sin(3 * phase),
      headingDeg: (phase * 180) / Math.PI,
    });
    return true;
  };
}
