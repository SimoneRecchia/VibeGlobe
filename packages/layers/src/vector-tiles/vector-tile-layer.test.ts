import type { FrameView, Globe, RenderExtension, RenderExtensionContext, TileTransport } from '@vibeglobe/core';
import { describe, expect, it } from 'vitest';
import type { VectorTileTarget } from './vector-target.js';
import { startVectorTileLayer } from './vector-tile-layer.js';
import { VectorStyle } from './vector-style.js';
import type { SourceInfo } from './style-sources.js';

/** A globe that shows the level-2 surface tiles of the whole world at `zoom`, with a flat relief. */
function fakeGlobe(zoom: number) {
  let extension: RenderExtension | undefined;
  const camera = { zoom, reliefFactor: 0, morphFactor: 0 };
  const surface: { root: string; level: number; x: number; y: number }[] = [];
  for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) surface.push({ root: 'mercator', level: 2, x, y });
  const context = {
    renderer: {},
    requestRender: () => undefined,
    setCredits: () => undefined,
  } as unknown as RenderExtensionContext;
  const globe = {
    camera,
    timeMs: 0,
    frameNumber: 0,
    requestRender: () => undefined,
    surfaceTiles: () => surface,
    screenToGeo: () => undefined,
    geoToScreen: () => undefined,
    terrainStats: () => undefined,
    addRenderExtension: (create: (context: RenderExtensionContext) => RenderExtension) => {
      extension = create(context);
      return () => extension?.dispose();
    },
  } as unknown as Globe;
  const frame = () => extension?.frame({ widthPx: 320, heightPx: 240 } as FrameView);
  return { globe, camera, frame };
}

const target = (): VectorTileTarget =>
  ({
    atlas: { get: () => undefined },
    createMesh: () => ({ update: () => undefined, dispose: () => undefined }),
    draw: () => undefined,
    setLabels: () => undefined,
    removeLayer: () => undefined,
    dispose: () => undefined,
  }) as unknown as VectorTileTarget;

/** A transport that records every URL and never answers. */
function recording(urls: string[]): TileTransport {
  return {
    start(request) {
      urls.push(request.url);
      return () => undefined;
    },
  };
}

const SOURCE: SourceInfo = { templates: ['t/{z}/{x}/{y}.pbf'], scheme: 'xyz', coverage: { minzoom: 0, maxzoom: 14 } };

describe('vector tile requests (KB-291)', () => {
  it('requests no tile while none of a source’s visible layers draws at the zoom, and loads them once one does', () => {
    const start = () => {
      const urls: string[] = [];
      const style = VectorStyle.load({
        version: 8,
        sources: { v: { type: 'vector', tiles: ['t/{z}/{x}/{y}.pbf'] } },
        layers: [
          { id: 'roads', type: 'line', source: 'v', 'source-layer': 'roads', minzoom: 3 },
          { id: 'water', type: 'fill', source: 'v', 'source-layer': 'water', layout: { visibility: 'none' } },
        ],
      });
      const { globe, camera, frame } = fakeGlobe(1.5);
      startVectorTileLayer(globe, { style: {}, target, transport: recording(urls) }, style, new Map([['v', SOURCE]]));
      frame();
      return { urls, style, camera, frame };
    };
    const shown = start();
    expect(shown.urls).toEqual([]);
    shown.style.setVisibility('water', true);
    shown.frame();
    expect(shown.urls.length).toBeGreaterThan(0);
    const zoomed = start();
    zoomed.camera.zoom = 3.2;
    zoomed.frame();
    expect(zoomed.urls.length).toBeGreaterThan(0);
  });
});
