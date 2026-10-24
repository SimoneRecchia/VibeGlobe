// Data layers: the layer stack drawn on the running globe.
import type { Globe } from '@vibeglobe/core';
import { createGlobeLayers } from '@vibeglobe/layers';

export async function enable(globe: Globe): Promise<string> {
  await globe.ready;
  const layers = createGlobeLayers(globe);
  return `data layers: ${Object.keys(layers).length > 0 ? 'stack created' : 'empty'}`;
}
