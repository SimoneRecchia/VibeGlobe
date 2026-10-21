// A host application that renders its own page first and loads the engine with a dynamic import only when the user
// asks for the map (F547): until then no engine or three.js code is downloaded.
import type { Globe } from '@vibeglobe/core';

declare global {
  interface Window {
    /** The globe, once the user has asked for it (read by the end-to-end test). */
    lazyHostGlobe?: Globe;
  }
}

const button = document.querySelector<HTMLButtonElement>('#show-map');
const map = document.querySelector<HTMLDivElement>('#map');
const status = document.querySelector<HTMLParagraphElement>('#map-status');

async function showMap(container: HTMLDivElement): Promise<void> {
  const [{ createGlobe }, { createRenderer }, { createControls }] = await Promise.all([
    import('@vibeglobe/core'),
    import('@vibeglobe/renderer'),
    import('@vibeglobe/controls'),
  ]);
  const requested = new URLSearchParams(location.search).get('backend');
  const backend = requested === 'webgpu' || requested === 'webgl2' ? requested : 'auto';
  const globe = createGlobe({
    container,
    renderer: createRenderer({ backend }),
    controls: createControls(),
    baseImageryUrl: `${import.meta.env.BASE_URL}imagery/natural-earth-4096.jpg`,
    view: { longitudeDeg: 12.5, latitudeDeg: 42, zoom: 4.5 },
  });
  window.lazyHostGlobe = globe;
  await globe.ready;
  if (status) status.textContent = `Map ready (${globe.backend ?? 'unknown'})`;
}

button?.addEventListener('click', () => {
  if (!map) return;
  button.disabled = true;
  if (status) status.textContent = 'Loading the map…';
  showMap(map).catch((error: unknown) => {
    if (status) status.textContent = `The map could not start: ${String(error)}`;
  });
});
