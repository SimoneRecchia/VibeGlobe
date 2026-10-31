import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Scene, Texture } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { LayerModels } from './layer-models.js';

/** A glTF scene of one textured box, and the loader that hands it over when `release` is called. */
function model() {
  const map = new Texture();
  const scene = new Group();
  scene.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial({ map })));
  let release: () => void = () => undefined;
  const loaded = new Promise<void>((resolve) => (release = resolve));
  const loader = {
    parseAsync: async () => {
      await loaded;
      return { scene };
    },
    loadAsync: async () => ({ scene }),
  };
  const disposed: string[] = [];
  map.addEventListener('dispose', () => disposed.push('texture'));
  return { loader, release, disposed, scene };
}

describe('LayerModels', () => {
  it("frees a removed model's base color texture with its material", async () => {
    const { loader, release, disposed } = model();
    const models = new LayerModels(new Scene());
    models.loaderFactory = async () => loader;
    release();
    const id = await models.load({ data: new ArrayBuffer(0) });
    models.remove(id);
    expect(disposed).toEqual(['texture']);
  });

  it('frees a model that arrives after the renderer was destroyed instead of adding it', async () => {
    const { loader, release, disposed, scene: gltf } = model();
    const scene = new Scene();
    const models = new LayerModels(scene);
    models.loaderFactory = async () => loader;
    const loading = models.load({ data: new ArrayBuffer(0) });
    models.dispose();
    release();
    await expect(loading).rejects.toThrow(/destroyed/);
    expect(scene.children).not.toContain(gltf);
    expect(disposed).toEqual(['texture']);
  });
});
