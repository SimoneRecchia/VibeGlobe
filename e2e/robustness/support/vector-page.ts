// Loaded into the playground page by the vector chaos scenarios (F510): adds a vector tile style to the page's globe as
// a host does, awaiting the outcome, so a failed style is the host's handled error and not an unhandled rejection.
import type { Globe } from '@vibeglobe/core';
import { addVectorTiles, type VectorTileLayer } from '@vibeglobe/layers/vector-tiles';
import { createVectorTileTarget } from '@vibeglobe/renderer/vector-tiles';

/** What the scenarios read back. */
declare global {
  interface Window {
    robustnessVectorLayer?: VectorTileLayer;
  }
}

/** @public Loaded into the page by URL. Adds the style at `url`; resolves with 'ok' or the error's text. */
export async function addStyle(globe: Globe, url: string): Promise<string> {
  try {
    window.robustnessVectorLayer = await addVectorTiles(globe, { style: url, target: createVectorTileTarget });
    return 'ok';
  } catch (error) {
    return String(error);
  }
}
