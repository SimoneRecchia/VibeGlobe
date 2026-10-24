// Terrain: restarts the globe with a terrain source, decoded by the worker program.
import { createGlobe, type Globe } from '@vibeglobe/core';
import { createRenderer } from '@vibeglobe/renderer';
import { heightmapTerrain } from '@vibeglobe/sources';
import { createWorkers } from '@vibeglobe/worker';

export async function enable(globe: Globe, container: HTMLElement, backend: 'auto' | 'webgpu' | 'webgl2'): Promise<string> {
  const view = globe.camera;
  globe.destroy();
  const terrain = heightmapTerrain({
    id: 'terrain',
    url: `${location.origin}/fixture-tiles/release/terrain/mercator/{z}/{x}/{y}.terrarium.png`,
    encoding: 'terrarium',
    maxLevel: 8,
  });
  const next = createGlobe({
    container,
    renderer: createRenderer({ backend }),
    baseImageryUrl: '/natural-earth-4096.jpg',
    workers: createWorkers(),
    terrain,
    view: { longitudeDeg: view.longitudeDeg, latitudeDeg: view.latitudeDeg, zoom: view.zoom },
  });
  window.lazyGlobe = next;
  await next.ready;
  return `terrain ${terrain.id} on ${next.backend ?? 'no backend'}`;
}
