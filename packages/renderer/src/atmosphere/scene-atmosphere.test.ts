import { Mesh, Scene } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { SceneAtmosphere } from './scene-atmosphere.js';

describe('SceneAtmosphere', () => {
  it('keeps surface meshes before the sky, so the sky is drawn only where the globe left the background', () => {
    const scene = new Scene();
    const atmosphere = new SceneAtmosphere(scene);
    atmosphere.setQuality({ anisotropy: 1, antialias: 'none', atmosphere: 'low', fog: true }, 'reversed-z');
    const [first, second] = [new Mesh(), new Mesh()];
    atmosphere.addBelowSky(first);
    atmosphere.addBelowSky(second);
    const sky = atmosphere.current?.sky;
    expect(scene.children).toEqual([first, second, sky]);
    expect(second.parent).toBe(scene);
    atmosphere.dispose();
    // Without a sky the meshes are simply added.
    const third = new Mesh();
    atmosphere.addBelowSky(third);
    expect(scene.children).toEqual([first, second, third]);
  });
});
