import { describe, expect, it } from 'vitest';
import { DrawList } from './draw-list.js';
import { ImageryFades } from './fades.js';
import { quadtreeTileKey } from '../surface/surface-quadtree.hot.js';

/** A one-tile list showing `texture` at `level`. */
function frame(list: DrawList, texture: number, level: number, key = 7): DrawList {
  list.count = 1;
  list.meshKeys[0] = key;
  list.textures[0] = texture;
  list.imageryLevels[0] = level;
  list.geographic[0] = 0;
  list.uvTransforms.set([0.5, 0.5, level, 0]);
  return list;
}

describe('ImageryFades (F105)', () => {
  it('cross-fades a tile from its old imagery to the new one over the duration, keeping the old one resident', () => {
    const fades = new ImageryFades();
    const list = new DrawList(4);
    const kept: number[] = [];
    const keep = (handle: number): void => void kept.push(handle);
    const now = new Float64Array([0]);
    fades.apply(frame(list, 10, 3), list.imageryLayer, now, 250, keep);
    expect([list.fades[0], fades.fading]).toEqual([1, false]);
    now[0] = 100;
    fades.apply(frame(list, 11, 4), list.imageryLayer, now, 250, keep);
    expect([list.fades[0], list.fromTextures[0], [...list.fromUvTransforms.subarray(0, 4)]]).toEqual([
      0,
      10,
      [0.5, 0.5, 3, 0],
    ]);
    // Finer imagery arriving mid-fade waits for the fade to end: what the tile shows never jumps.
    now[0] = 225;
    fades.apply(frame(list, 12, 5), list.imageryLayer, now, 250, keep);
    expect([list.textures[0], list.imageryLevels[0], list.fromTextures[0]]).toEqual([11, 4, 10]);
    expect(list.fades[0]).toBeCloseTo(0.5);
    expect(fades.fading).toBe(true);
    // The imagery the fade still shows (11) stays resident too, not only the newer one (M3 review).
    expect(kept).toEqual([10, 12, 11, 10]);
    now[0] = 350;
    fades.apply(frame(list, 12, 5), list.imageryLayer, now, 250, keep);
    expect([list.fades[0], list.fromTextures[0], list.textures[0]]).toEqual([0, 11, 12]);
    now[0] = 600;
    fades.apply(frame(list, 12, 5), list.imageryLayer, now, 250, keep);
    expect([list.fades[0], list.fromTextures[0], fades.fading]).toEqual([1, 12, false]);
  });

  it('a tile that appears by refinement fades from the imagery its parent showed, not at once (KB-199)', () => {
    const fades = new ImageryFades();
    const list = new DrawList(4);
    const now = new Float64Array([0]);
    const parent = quadtreeTileKey(0, 3, 2, 5);
    const child = quadtreeTileKey(0, 4, 5, 10);
    frame(list, 10, 3, parent);
    list.uvTransforms.set([0.5, 0.5, 0.25, 0]);
    fades.apply(list, list.imageryLayer, now, 250, () => undefined);
    now[0] = 16;
    // The child (east half, north half of its parent) already has finer imagery: it fades in from the parent's.
    fades.apply(frame(list, 11, 4, child), list.imageryLayer, now, 250, () => undefined);
    expect([list.fades[0], list.fromTextures[0], [...list.fromUvTransforms.subarray(0, 4)]]).toEqual([
      0,
      10,
      [0.25, 0.25, 0.5, 0],
    ]);
    expect(fades.fading).toBe(true);
    // Its own child appears mid-fade: it goes on with the same fade, from the same imagery, not from the newer one.
    now[0] = 116;
    fades.apply(frame(list, 12, 5, quadtreeTileKey(0, 5, 10, 21)), list.imageryLayer, now, 250, () => undefined);
    expect(list.fades[0]).toBeCloseTo(0.4, 6);
    expect([list.fromTextures[0], [...list.fromUvTransforms.subarray(0, 4)]]).toEqual([10, [0.125, 0.125, 0.5, 0.125]]);
  });

  it('a tile that appears by refinement during the fade of its parent to the same imagery goes on with that fade (KB-199)', () => {
    const fades = new ImageryFades();
    const list = new DrawList(4);
    const now = new Float64Array([0]);
    const parent = quadtreeTileKey(0, 3, 2, 5);
    fades.apply(frame(list, 10, 3, parent), list.imageryLayer, now, 250, () => undefined);
    now[0] = 100;
    fades.apply(frame(list, 11, 3, parent), list.imageryLayer, now, 250, () => undefined);
    // Its child shows the parent's new imagery too: the fade from 10 goes on, not cut off.
    now[0] = 200;
    fades.apply(frame(list, 11, 3, quadtreeTileKey(0, 4, 4, 10)), list.imageryLayer, now, 250, () => undefined);
    expect(list.fades[0]).toBeCloseTo(0.4, 6);
    expect(list.fromTextures[0]).toBe(10);
  });

  it('a tile that appears by coarsening fades from the stand-in its children all showed (KB-199)', () => {
    const fades = new ImageryFades();
    const list = new DrawList(8);
    const now = new Float64Array([0]);
    // Four children at level 4 all magnify the same level-1 stand-in (texture 10), each its own sixteenth of it.
    list.count = 4;
    for (let k = 0; k < 4; k++) {
      const x = 4 + (k & 1);
      const y = 10 + (k >> 1);
      list.meshKeys[k] = quadtreeTileKey(0, 4, x, y);
      list.textures[k] = 10;
      list.imageryLevels[k] = 1;
      list.geographic[k] = 0;
      list.uvTransforms.set([0.125, 0.125, (x % 8) / 8, (y % 8) / 8], k * 4);
    }
    fades.apply(list, list.imageryLayer, now, 250, () => undefined);
    now[0] = 16;
    // Their parent replaces them with its own level-3 imagery: it fades in from its quarter of the stand-in.
    fades.apply(frame(list, 11, 3, quadtreeTileKey(0, 3, 2, 5)), list.imageryLayer, now, 250, () => undefined);
    expect([list.fades[0], list.fromTextures[0], [...list.fromUvTransforms.subarray(0, 4)]]).toEqual([
      0,
      10,
      [0.25, 0.25, 0.5, 0.25],
    ]);
  });

  it('a tile that appears by coarsening during the fade of its children goes on with that fade (KB-199)', () => {
    const fades = new ImageryFades();
    const list = new DrawList(8);
    const now = new Float64Array([0]);
    const children = (texture: number): DrawList => {
      list.count = 4;
      for (let k = 0; k < 4; k++) {
        const x = 4 + (k & 1);
        const y = 10 + (k >> 1);
        list.meshKeys[k] = quadtreeTileKey(0, 4, x, y);
        list.textures[k] = texture;
        list.imageryLevels[k] = 1;
        list.geographic[k] = 0;
        list.uvTransforms.set([0.125, 0.125, (x % 8) / 8, (y % 8) / 8], k * 4);
      }
      return list;
    };
    fades.apply(children(10), list.imageryLayer, now, 250, () => undefined);
    now[0] = 100;
    fades.apply(children(11), list.imageryLayer, now, 250, () => undefined);
    // Their parent shows the imagery they fade to: the fade from the stand-in goes on.
    now[0] = 200;
    fades.apply(frame(list, 11, 3, quadtreeTileKey(0, 3, 2, 5)), list.imageryLayer, now, 250, () => undefined);
    expect(list.fades[0]).toBeCloseTo(0.4, 6);
    expect([list.fromTextures[0], [...list.fromUvTransforms.subarray(0, 4)]]).toEqual([10, [0.25, 0.25, 0.5, 0.25]]);
  });

  it('switches at once with no duration, and a tile drawn again after a gap starts without a fade', () => {
    const fades = new ImageryFades();
    const list = new DrawList(4);
    const now = new Float64Array([0]);
    fades.apply(frame(list, 10, 3), list.imageryLayer, now, 0, () => undefined);
    fades.apply(frame(list, 11, 4), list.imageryLayer, now, 0, () => undefined);
    expect(list.fades[0]).toBe(1);
    fades.apply(frame(list, 12, 5, 8), list.imageryLayer, now, 250, () => undefined);
    fades.apply(frame(list, 13, 6), list.imageryLayer, now, 250, () => undefined);
    expect([list.fades[0], fades.fading]).toEqual([1, false]);
  });

  it('switches at once across more levels than the gap allows, and fades within it (terrain morphs, KB-079)', () => {
    const fades = new ImageryFades();
    const list = new DrawList(4);
    const now = new Float64Array([0]);
    const keep = (): void => undefined;
    fades.apply(frame(list, 10, 2), list.imageryLayer, now, 250, keep, 2);
    // From a level-2 fallback straight to level 10: no morph.
    now[0] = 100;
    fades.apply(frame(list, 11, 10), list.imageryLayer, now, 250, keep, 2);
    expect([list.fades[0], list.fromTextures[0], fades.fading]).toEqual([1, 11, false]);
    // One level finer: a morph.
    now[0] = 400;
    fades.apply(frame(list, 12, 11), list.imageryLayer, now, 250, keep, 2);
    expect([list.fades[0], list.fromTextures[0], fades.fading]).toEqual([0, 11, true]);
  });
});
