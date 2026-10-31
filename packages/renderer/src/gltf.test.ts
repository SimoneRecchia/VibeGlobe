import { describe, expect, it, vi } from 'vitest';

let loaded = false;
vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => {
  loaded = true;
  return {
    GLTFLoader: class {
      readonly kind = 'gltf';
    },
  };
});

describe('the glTF loader entry (KB-297)', () => {
  it("loads three.js's glTF loader only when the first model asks for it", async () => {
    const { gltfLoader } = await import('./gltf.js');
    expect(loaded).toBe(false);
    expect(await gltfLoader()).toBeDefined();
    expect(loaded).toBe(true);
  });
});
