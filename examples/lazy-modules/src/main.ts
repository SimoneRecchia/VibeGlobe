// A consumer application that starts with only the core and the renderer (the pinned base imagery) and loads each
// optional module with a dynamic import when it is enabled (F503).
import { createGlobe, type Globe } from '@vibeglobe/core';
import { createRenderer } from '@vibeglobe/renderer';

declare global {
  interface Window {
    /** The running globe, the optional modules and the switch that enables one (scripts/release/check-consumers.ts). */
    lazyGlobe?: Globe;
    optionalModules?: string[];
    enableModule?: (name: string) => Promise<string>;
  }
}

const container = document.querySelector<HTMLDivElement>('#map');
if (!container) throw new Error('#map is missing');
const requested = new URLSearchParams(location.search).get('backend');
const backend = requested === 'webgpu' || requested === 'webgl2' ? requested : 'auto';
window.lazyGlobe = createGlobe({
  container,
  renderer: createRenderer({ backend }),
  baseImageryUrl: '/natural-earth-4096.jpg',
  view: { longitudeDeg: 12.5, latitudeDeg: 42, zoom: 4 },
});

/** Each optional module, behind its own dynamic import; enabling one returns what it did. */
const modules: Record<string, (globe: Globe) => Promise<string>> = {
  terrain: async (globe) => (await import('./modules/terrain.js')).enable(globe, container, backend),
  'vector-tiles': async (globe) => (await import('./modules/vector-tiles.js')).enable(globe),
  '3d-tiles': async (globe) => (await import('./modules/3d-tiles.js')).enable(globe),
  'data-layers': async (globe) => (await import('./modules/data-layers.js')).enable(globe),
  ui: async (globe) => (await import('./modules/ui.js')).enable(globe, container),
  offline: async () => (await import('./modules/offline.js')).enable(),
};
window.optionalModules = Object.keys(modules);
window.enableModule = async (name) => {
  const enable = modules[name];
  if (!enable || !window.lazyGlobe) throw new Error(`no module ${name}`);
  return enable(window.lazyGlobe);
};
