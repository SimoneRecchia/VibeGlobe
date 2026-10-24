import type { Globe } from '@vibeglobe/core';
import { createGlobeLayers, MarkerLodLayer, type Feature } from '@vibeglobe/layers';
import { markerImages } from './marker-images.js';

/** Markers of the scenario: a 400 by 250 grid over central Europe, 0.04° apart (about 3 to 4 km). */
const COLUMNS = 400;
const ROWS = 250;

/**
 * `?scenario=data-markers-lod` (F374): 100,000 pin markers with level of detail. The debug overlay (`&debug=1`) shows
 * how many draw in full, as dots and fading (`window.vibeglobeDebugRows`); `window.vibeglobeMarkerLod` is the layer.
 */
export function showMarkerLod(globe: Globe): void {
  for (const [image, source] of Object.entries(markerImages())) globe.layerTarget()?.addImage?.(image, source);
  const element = document.querySelector<HTMLElement>('#globe') ?? undefined;
  const { stack } = createGlobeLayers(globe, element ? { element } : {});
  const features: Feature[] = Array.from({ length: COLUMNS * ROWS }, (_, i) => ({
    type: 'Feature',
    id: i,
    properties: {},
    geometry: { type: 'Point', coordinates: [2 + (i % COLUMNS) * 0.04, 42 + Math.floor(i / COLUMNS) * 0.04] },
  }));
  const layer = stack.add(
    new MarkerLodLayer({
      id: 'markers-lod',
      data: features,
      style: { 'icon-image': 'pin', 'icon-anchor': 'bottom', 'icon-size': 24 },
      lod: { dotStyle: { 'circle-color': '#ff3030', 'circle-radius': 2 } },
    }),
  );
  window.vibeglobeMarkerLod = layer;
  window.vibeglobeDebugRows = () => {
    const { full, simplified, fading } = layer.lodStats;
    return [
      ['marker-lod', `markers full ${String(full)} · simplified ${String(simplified)} · fading ${String(fading)}`],
    ];
  };
}

declare global {
  interface Window {
    vibeglobeMarkerLod?: MarkerLodLayer;
    /** Rows a scenario adds to the debug overlay. */
    vibeglobeDebugRows?: () => (readonly [string, string])[];
  }
}
