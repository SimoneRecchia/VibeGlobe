import type { DepthPath } from '@vibeglobe/core';
import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  LinearMipmapLinearFilter,
  Mesh,
  RenderTarget,
  Scene,
  type Material,
  type WebGPURenderer,
} from 'three/webgpu';
import { EngineCamera } from './engine-camera.js';
import { createSurfaceMaterial } from './surface-material.js';

/**
 * A scene with one triangle per material variant, laid out like a surface tile (float32 positions and uvs, 16-bit
 * indices) and covering the view of an identity camera: compiling or drawing it creates every pipeline the frames
 * need (ADR 0010 §4).
 */
interface WarmUpScene {
  readonly scene: Scene;
  readonly camera: EngineCamera;
  dispose(): void;
}

/** Builds a warm-up scene drawing each material once. */
function createWarmUpScene(materials: readonly Material[]): WarmUpScene {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(Float32Array.of(-1, -1, 0.5, 3, -1, 0.5, -1, 3, 0.5), 3));
  geometry.setAttribute('tileUv', new BufferAttribute(Float32Array.of(0, 0, 0, 2, 0, 0, 0, 2, 2), 3));
  geometry.setAttribute('tileNormal', new BufferAttribute(Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1), 3));
  geometry.setAttribute('tilePlane', new BufferAttribute(new Float32Array(12), 4));
  geometry.setIndex(new BufferAttribute(Uint16Array.of(0, 1, 2), 1));
  const scene = new Scene();
  scene.matrixWorldAutoUpdate = false;
  for (const material of materials) {
    const mesh = new Mesh(geometry, material);
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    mesh.frustumCulled = false;
    scene.add(mesh);
  }
  const camera = new EngineCamera();
  camera.matrixAutoUpdate = false;
  camera.matrixWorldAutoUpdate = false;
  camera.near = 0.5;
  return { scene, camera, dispose: () => geometry.dispose() };
}

/**
 * Compiles every material variant before the frames that draw it (ADR 0010 §4), so no frame waits for a pipeline.
 * Drawing an empty scene once also compiles three.js's output pass, which copies the scene into the canvas; the canvas
 * shows a cleared frame until the first frame.
 */
export async function warmUpPipelines(renderer: WebGPURenderer, materials: readonly Material[]): Promise<void> {
  const warmUp = createWarmUpScene(materials);
  try {
    await renderer.compileAsync(warmUp.scene, warmUp.camera);
    renderer.render(new Scene(), warmUp.camera);
  } finally {
    warmUp.dispose();
  }
}

/**
 * The WebGPU start-up self-test (ADR 0010 §2): uploads a mipmapped probe texture and draws the surface shader with it
 * into a small render target inside GPU error scopes. Resolves with the reason when the device reports an error or is
 * lost, else undefined. It catches what `init()` does not, such as a texture-view descriptor the browser rejects.
 */
export async function webgpuSelfTest(renderer: WebGPURenderer, depthPath: DepthPath): Promise<string | undefined> {
  const device = (renderer.backend as { device?: GPUDevice }).device;
  if (!device) return undefined;
  let lost: string | undefined;
  void device.lost.then((info) => (lost = `the device was lost: ${info.message || info.reason}`));
  const probe = new DataTexture(new Uint8Array(4 * 4 * 4).fill(255), 4, 4);
  probe.generateMipmaps = true;
  probe.minFilter = LinearMipmapLinearFilter;
  probe.needsUpdate = true;
  const material = createSurfaceMaterial(probe, depthPath);
  const warmUp = createWarmUpScene([material]);
  const target = new RenderTarget(4, 4);
  const scopes = ['validation', 'out-of-memory', 'internal'] as const;
  for (const scope of scopes) device.pushErrorScope(scope);
  let thrown: string | undefined;
  try {
    renderer.setRenderTarget(target);
    renderer.render(warmUp.scene, warmUp.camera);
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  } finally {
    renderer.setRenderTarget(null);
  }
  const errors = await Promise.all(scopes.map(() => device.popErrorScope()));
  await device.queue.onSubmittedWorkDone();
  target.dispose();
  material.dispose();
  probe.dispose();
  warmUp.dispose();
  const error = errors.find((candidate) => candidate !== null);
  return thrown ?? (error ? `${error.constructor.name}: ${error.message}` : lost);
}
