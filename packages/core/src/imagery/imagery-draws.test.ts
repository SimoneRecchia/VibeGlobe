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
    attributionOf: () => undefined,
    levelShift: 0,
  } as unknown as ImageryLoader;
  const source = { tiling: WEB_MERCATOR_TILING, minLevel: 0, maxLevel } as ImagerySource;
  return { layer: { source, loader, index: 0 }, wanted };
}

/** A stack layer over a chain of fake sources, with a look. */
function stacked(chain: ImageryLayer[], look: Partial<StackEntry> = {}): StackLayer {
  const entry: StackEntry = {
    id: 'a',
    sources: chain.map((l) => l.source),
    transparent: false,
    opacity: 1,
    visible: true,
    harmonize: true,
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

  it("requests a source's coarsest level and the level above one found missing, so a clipped pyramid draws (KB-179)", () => {
    // A pyramid from level 10 whose level 11 tile is missing (a region clipped at 11): its level 10 tile is wanted.
    const clipped = fakeLayer({}, [11]);
    const source = { ...clipped.layer.source, minLevel: 10 } as ImagerySource;
    draw({ ...clipped.layer, source }, tile(11, 1080, 730));
    expect(clipped.wanted.slice(0, 2)).toEqual([11, 10]);
    // A level 12 tile missing at 12: level 11, between the every-second ancestors, is wanted too.
    const gap = fakeLayer({}, [12]);
    draw(gap.layer, tile(12, 2160, 1460));
    expect(gap.wanted.slice(0, 3)).toEqual([12, 11, 10]);
  });

  it('prefetches no children under a center tile in full fog (F574, KB-174)', () => {
    const { layer, wanted } = fakeLayer({ 9: 42 });
    draw(layer, { ...tile(9, 300, 170), fogVisibility: 0.05 });
    expect(wanted).toEqual([9]);
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
    // While the online tile loads, its ancestors at the package's levels are not requested: the package's stand in.
    const loading = fakeLayer({});
    const list9 = drawStack([stacked([fakeLayer({ 8: 40 }, [], 8).layer, loading.layer])], tile9);
    expect(loading.wanted.filter((level) => level <= 8)).toEqual([]);
    expect(list9.textures[0]).toBe(40);
    // Outside the online source's coverage its tile has no data: the package's level-8 tile is magnified.
    const outside = fakeLayer({}, [9]);
    const list = drawStack([stacked([fakeLayer({ 8: 40 }, [], 8).layer, outside.layer])], tile9);
    expect([list.textures[0], list.imageryLevels[0]]).toEqual([40, 8]);
  });

  it('magnifies the next source where the detail source before it has no tile, coverage undeclared (KB-142)', () => {
    // A high-detail build answers 404 outside its area: the world's level-8 tile is magnified there, not nothing.
    const detail = fakeLayer({}, [9, 10, 11, 12]);
    const world = fakeLayer({ 8: 60 }, [], 8);
    const list = drawStack([stacked([detail.layer, world.layer])], tile(12, 2124, 1456));
    expect([list.textures[0], list.imageryLevels[0]]).toEqual([60, 8]);
  });

  it("magnifies a lone source's ancestor where its own tile fails, with no other source (KB-149, F242)", () => {
    // Tiles from level 6 on fail to decode: the level-5 tile is magnified, not nothing.
    const only = fakeLayer({ 5: 70 }, [6, 7, 8]);
    const list = drawStack([stacked([only.layer])], tile(8, 130, 90));
    expect([list.textures[0], list.imageryLevels[0]]).toEqual([70, 5]);
  });

  it("magnifies a source's ancestor where its own tile fails and no later source covers the tile (KB-149)", () => {
    const failing = fakeLayer({ 5: 70 }, [6, 7, 8]);
    const elsewhere = fakeLayer({ 5: 80 });
    const away = { westRad: -1.2, southRad: -0.6, eastRad: -1.0, northRad: -0.4 };
    const chain = [failing.layer, { ...elsewhere.layer, source: { ...elsewhere.layer.source, coverage: [away] } }];
    const list = drawStack([stacked(chain)], tile(8, 130, 90));
    expect([list.textures[0], list.imageryLevels[0]]).toEqual([70, 5]);
  });

  it('draws nothing of a source outside its coverage, not even a magnified ancestor (F094, F254)', () => {
    const covered = fakeLayer({ 2: 50 });
    const italy = { westRad: 0.11, southRad: 0.62, eastRad: 0.32, northRad: 0.83 };
    const outside = tile(9, 258, 175); // around 1.4° E, 48.9° N
    const list = drawStack(
      [stacked([{ ...covered.layer, source: { ...covered.layer.source, coverage: [italy] } }])],
      outside,
    );
    expect(list.textures[0]).toBe(-1);
    expect(covered.wanted).toEqual([]);
  });

  it('keeps each translucent layer in its overlay slot while a layer below it loads (KB-155)', () => {
    const base = fakeLayer({ 9: 10 });
    const loading = fakeLayer({});
    const labels = fakeLayer({ 9: 12 });
    const list = drawStack(
      [
        stacked([base.layer]),
        stacked([loading.layer], { id: 'utm', transparent: true }),
        stacked([labels.layer], { id: 'labels', transparent: true }),
      ],
      tile(9, 300, 170),
    );
    // The loading layer holds slot 0 empty; the labels stay in slot 1, where they will be once it arrives.
    expect([list.overlays[0]?.textures[0], list.overlays[0]?.opacities[0]]).toEqual([-1, 0]);
    expect(list.overlays[1]?.textures[0]).toBe(12);
  });

  it('gives no overlay slot to a translucent layer whose sources cover none of the tile (F618)', () => {
    const base = fakeLayer({ 9: 10 });
    const here = fakeLayer({ 9: 12 });
    // Two clipped layers of other countries, far from this tile, above the one that has it.
    const abroad = (id: string): StackLayer => {
      const away = fakeLayer({});
      const source = {
        ...away.layer.source,
        coverage: [{ westRad: -3, southRad: -1.4, eastRad: -2.9, northRad: -1.3 }],
      };
      return stacked([{ ...away.layer, source }], { id, transparent: true });
    };
    const list = drawStack(
      [stacked([base.layer]), stacked([here.layer], { id: 'here', transparent: true }), abroad('a1'), abroad('a2')],
      tile(9, 300, 170),
    );
    expect(list.overlays[0]?.textures[0]).toBe(12);
  });

  it('composes a layer with transparent tiles over the ones below instead of covering them (F242)', () => {
    const base = fakeLayer({ 9: 10 });
    const transparent = fakeLayer({ 9: 11 });
    const list = drawStack(
      [stacked([base.layer]), stacked([transparent.layer], { id: 'clear', transparent: true })],
      tile(9, 300, 170),
    );
    expect([list.textures[0], list.overlays[0]?.textures[0], list.overlays[0]?.opacities[0]]).toEqual([10, 11, 1]);
  });
});
