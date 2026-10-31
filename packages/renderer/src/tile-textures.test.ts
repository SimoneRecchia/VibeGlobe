import type { WebGPURenderer } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { TileTextures } from './tile-textures.js';

const SIDE = 4;

function tile() {
  return {
    widthPx: SIDE,
    heightPx: SIDE,
    gpuBytes: SIDE * SIDE * 4,
    image: { data: new Uint8Array(SIDE * SIDE * 4), width: SIDE, height: SIDE },
  };
}

function setUp(count: number) {
  let level = 1;
  const uploads: number[] = [];
  const renderer = { initTexture: () => uploads.push(level) } as unknown as WebGPURenderer;
  const textures = new TileTextures(() => level);
  for (let handle = 0; handle < count; handle++) textures.upload(renderer, handle, tile());
  uploads.length = 0;
  return { textures, renderer, uploads, setLevel: (next: number) => (level = next) };
}

describe('TileTextures.refilter (KB-288)', () => {
  it('makes the tiles again a few at a time instead of all in the task that changed the anisotropy', () => {
    const { textures, renderer, uploads, setLevel } = setUp(10);
    setLevel(8);
    textures.refilter();
    expect(uploads).toHaveLength(0);
    expect(textures.refilterSome(renderer, 4)).toBe(4);
    expect(textures.refilterSome(renderer, 4)).toBe(4);
    expect(textures.refilterSome(renderer, 4)).toBe(2);
    expect(textures.refilterSome(renderer, 4)).toBe(0);
    expect(uploads).toEqual(Array(10).fill(8));
    for (let handle = 0; handle < 10; handle++) expect(textures.get(handle)?.anisotropy).toBe(8);
  });

  it('does nothing while every texture has the current anisotropy', () => {
    const { textures, renderer, uploads } = setUp(3);
    textures.refilter();
    expect(textures.refilterSome(renderer, 4)).toBe(0);
    expect(uploads).toHaveLength(0);
  });
});

describe('TileTextures with far-apart handles (KB-299)', () => {
  it('walks only the textures held: handles a layer apart cost nothing between them', () => {
    const { textures, renderer, setLevel } = setUp(0);
    // A layer's handles start at its index times 2^22: forty layers reach past 160 million.
    const handles = [3, 39 * 2 ** 22 + 7];
    for (const handle of handles) textures.upload(renderer, handle, tile());
    setLevel(8);
    textures.refilter();
    const startMs = performance.now();
    expect(textures.refilterSome(renderer, 4)).toBe(2);
    expect(performance.now() - startMs).toBeLessThan(50);
    textures.clear();
    expect(textures.size).toBe(0);
  });
});
