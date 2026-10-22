import { describe, expect, it } from 'vitest';
import { Camera } from '../camera/camera.js';
import { MERCATOR_ROOT, quadtreeTileBounds, type QuadtreeTile } from '../surface/surface-quadtree.hot.js';
import { WEB_MERCATOR_TILING } from '../tiling/tiling-scheme.js';
import { DrawList, drawOnBaseImage } from './draw-list.js';
import { drawImagery, type ImageryLayer } from './imagery-draws.js';
import { ARRIVING, type ImageryLoader } from './imagery-loader.hot.js';
import type { ImagerySource } from './imagery-source.js';

const tile = (level: number, x: number, y: number): QuadtreeTile =>
  quadtreeTileBounds(MERCATOR_ROOT, level, x, y, 1, {
    key: 0,
    root: 0,
    level: 0,
    x: 0,
    y: 0,
    span: 1,
    westRad: 0,
    southRad: 0,
    eastRad: 0,
    northRad: 0,
  });

/** A loader stand-in: `states` maps a level to what `want`/`readyHandle` answer there; calls are recorded. */
function fakeLayer(states: Record<number, number>): { layer: ImageryLayer; wanted: number[] } {
  const wanted: number[] = [];
  const loader = {
    want: (level: number) => {
      wanted.push(level);
      return states[level] ?? -1;
    },
    readyHandle: (level: number) => ((states[level] ?? -1) >= 0 ? (states[level] ?? -1) : -1),
    markDrawn: () => undefined,
  } as unknown as ImageryLoader;
  const source = { tiling: WEB_MERCATOR_TILING, minLevel: 0, maxLevel: 18 } as ImagerySource;
  return { layer: { source, loader }, wanted };
}

function draw(layer: ImageryLayer, surface: QuadtreeTile): DrawList {
  const list = new DrawList(1);
  drawOnBaseImage(list, [surface], 1);
  const camera = new Camera();
  camera.widthPx = 800;
  camera.heightPx = 600;
  camera.update();
  drawImagery(list, [surface], 1, [layer], camera);
  return list;
}

describe('drawImagery', () => {
  it('wants the tile and every second ancestor, coarse first, and draws the deepest resident one (F082, F085)', () => {
    const { layer, wanted } = fakeLayer({ 4: 42 });
    const list = draw(layer, tile(9, 300, 170));
    // Then the prefetch of the next level under the center: the four children (F088).
    expect(wanted).toEqual([9, 7, 5, 10, 10, 10, 10]);
    expect(list.textures[0]).toBe(42);
    expect(list.imageryLevels[0]).toBe(4);
  });

  it('requests no ancestor while the tile itself is arriving from the RAM tier (F097)', () => {
    const { layer, wanted } = fakeLayer({ 9: ARRIVING, 4: 42 });
    const list = draw(layer, tile(9, 300, 170));
    expect(wanted).toEqual([9, 10, 10, 10, 10]);
    expect(list.textures[0]).toBe(42);
  });
});
