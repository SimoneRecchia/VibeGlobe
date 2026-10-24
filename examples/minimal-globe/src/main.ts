// A consumer application with the core, the renderer, one imagery source and the basic worker program (ADR 0172), and
// nothing else.
// The imagery is KTX2, so its tiles go through the worker's WebAssembly transcoder. `?assets=<base path>` loads the
// engine assets (the worker program and its WebAssembly) from there instead of where the bundler emitted them (F531).
import { createGlobe, type Globe } from '@vibeglobe/core';
import { createRenderer } from '@vibeglobe/renderer';
import { xyzImagery } from '@vibeglobe/sources';
import { createWorkers } from '@vibeglobe/worker/basic';

declare global {
  interface Window {
    /** The globe, for the release checks (scripts/release/check-consumers.ts). */
    minimalGlobe?: Globe;
  }
}

const params = new URLSearchParams(location.search);
const assets = params.get('assets');
const requested = params.get('backend');
const container = document.querySelector<HTMLDivElement>('#map');
if (!container) throw new Error('#map is missing');
window.minimalGlobe = createGlobe({
  container,
  renderer: createRenderer({ backend: requested === 'webgpu' || requested === 'webgl2' ? requested : 'auto' }),
  baseImageryUrl: '/natural-earth-4096.jpg',
  workers: createWorkers(assets === null ? {} : { url: `${assets}vibeglobe-worker.js` }),
  imagery: [
    xyzImagery({
      id: 'imagery',
      url: `${location.origin}/fixture-tiles/release/world/mercator/{z}/{x}/{y}.etc1s.ktx2`,
      decoder: 'ktx2',
      maxLevel: 6,
    }),
  ],
  view: { longitudeDeg: 12.5, latitudeDeg: 42, zoom: 4 },
});
