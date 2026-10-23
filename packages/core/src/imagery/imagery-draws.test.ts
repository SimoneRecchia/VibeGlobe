import { describe, expect, it } from 'vitest';
import { Camera } from '../camera/camera.js';
import { MERCATOR_ROOT, quadtreeTileBounds, type QuadtreeTile } from '../surface/surface-quadtree.hot.js';
import { WEB_MERCATOR_TILING } from '../tiling/tiling-scheme.js';
import { DrawList, drawOnBaseImage } from './draw-list.js';
import { drawImagery, type ImageryLayer, type StackLayer } from './imagery-draws.js';
import type { StackEntry } from './imagery-stack.js';
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

/**
 * A loader stand-in: `states` maps a level to what `want`/`readyHandle` answer there, `unavailable` the levels whose
 * tiles are missing or failing; calls are recorded.
 */
function fakeLayer(
  states: Record<number, number>,
  unavailable: number[] = [],
  maxLevel = 18,
): { layer: ImageryLayer; wanted: number[] } {
  const wanted: number[] = [];
  const loader = {
    want: (level: number) => {
      wanted.push(level);
      return states[level] ?? -1;
    },
    readyHandle: (level: number) => ((states[level] ?? -1) >= 0 ? (states[level] ?? -1) : -1),
    unavailable: (level: number) => unavailable.includes(level),
    markDrawn: () => undefined,
  } as unknown as ImageryLoader;
  const source = { tiling: WEB_MERCATOR_TILING, minLevel: 0, maxLevel } as ImagerySource;
  return { layer: { source, loader }, wanted };
}

/** A stack layer over a chain of fake sources, with a look. */
function stacked(chain: ImageryLayer[], look: Partial<StackEntry> = {}): StackLayer {
  const entry: StackEntry = {
    id: 'a',
    sources: chain.map((l) => l.source),
    opacity: 1,
    visible: true,
    blend: 'normal',
  };
  return { entry: { ...entry, ...look }, chain };
}

function drawStack(layers: StackLayer[], surface: QuadtreeTile): DrawList {
  const list = new DrawList(1);
  drawOnBaseImage(list, [surface], 1);
  const camera = new Camera();
  camera.widthPx = 800;
  camera.heightPx = 600;
  camera.update();
  drawImagery(list, [surface], 1, layers, camera);
  return list;
}

const draw = (layer: ImageryLayer, surface: QuadtreeTile): DrawList => drawStack([stacked([layer])], surface);

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

  it('draws the topmost opaque layer as the base and the translucent or blended layers above it as overlays (F244, F246)', () => {
    const base = fakeLayer({ 9: 10 });
    const covered = fakeLayer({ 9: 11 });
    const hillshade = fakeLayer({ 9: 12 });
    const labels = fakeLayer({ 9: 13 });
    const list = drawStack(
      [
        stacked([covered.layer], { id: 'covered' }),
        stacked([base.layer], { id: 'base' }),
        stacked([hillshade.layer], { id: 'hillshade', blend: 'multiply' }),
        stacked([labels.layer], { id: 'labels', opacity: 0.5 }),
      ],
      tile(9, 300, 170),
    );
    expect(list.textures[0]).toBe(10);
    expect([list.overlays[0]?.textures[0], list.overlays[0]?.blends[0], list.overlays[0]?.opacities[0]]).toEqual([
      12, 1, 1,
    ]);
    expect([list.overlays[1]?.textures[0], list.overlays[1]?.blends[0], list.overlays[1]?.opacities[0]]).toEqual([
      13, 0, 0.5,
    ]);
  });

  it('requests nothing for a hidden layer and leaves its overlay slot empty (F245)', () => {
    const base = fakeLayer({ 9: 10 });
    const hidden = fakeLayer({ 9: 12 });
    const list = drawStack(
      [stacked([base.layer]), stacked([hidden.layer], { id: 'hidden', opacity: 0.5, visible: false })],
      tile(9, 300, 170),
    );
    expect(hidden.wanted).toEqual([]);
    expect(list.overlays[0]?.opacities[0]).toBe(0);
  });

  it('takes a tile from the next source of a chain where the first has none or fails, and shows a resident one meanwhile (F247, F248)', () => {
    const offline = fakeLayer({ 9: 20 }, [9]);
    const online = fakeLayer({ 9: 21 });
    expect(drawStack([stacked([offline.layer, online.layer])], tile(9, 300, 170)).textures[0]).toBe(21);
    expect(offline.wanted).toEqual([]);
    // The first source loads its tile: the second's resident one stands in, without being requested.
    const loading = fakeLayer({});
    const standIn = fakeLayer({ 9: 31 });
    expect(drawStack([stacked([loading.layer, standIn.layer])], tile(9, 300, 170)).textures[0]).toBe(31);
    expect(standIn.wanted).toEqual([]);
  });

  it('takes tiles deeper than the first source serves from the next one, and magnifies the first where no source has them (F247)', () => {
    const tile9 = tile(9, 300, 170);
    const packaged = fakeLayer({ 8: 40 }, [], 8);
    const online = fakeLayer({ 9: 41 });
    expect(drawStack([stacked([packaged.layer, online.layer])], tile9).textures[0]).toBe(41);
    // Outside the online source's coverage its tile has no data: the package's level-8 tile is magnified.
    const outside = fakeLayer({}, [9]);
    const list = drawStack([stacked([fakeLayer({ 8: 40 }, [], 8).layer, outside.layer])], tile9);
    expect([list.textures[0], list.imageryLevels[0]]).toEqual([40, 8]);
  });
});
