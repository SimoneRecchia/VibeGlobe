// Vector tiles: the layer that adds them and the renderer's drawing target.
import type { Globe } from '@vibeglobe/core';
import { addVectorTiles } from '@vibeglobe/layers/vector-tiles';
import { createVectorTileTarget } from '@vibeglobe/renderer/vector-tiles';

export async function enable(globe: Globe): Promise<string> {
  await globe.ready;
  return `vector tiles: ${typeof addVectorTiles}, ${typeof createVectorTileTarget}`;
}
