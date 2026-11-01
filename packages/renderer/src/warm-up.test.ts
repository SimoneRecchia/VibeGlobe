import { MeshBasicMaterial, type WebGPURenderer } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import { warmUpPipelines } from './warm-up.js';

describe('pipeline warm-up', () => {
  it('draws no empty frame with a renderer released while it compiled, which three.js would keep alive (TG-06)', async () => {
    let compiled: () => void = () => undefined;
    const renderer = {
      compileAsync: () => new Promise<void>((resolve) => (compiled = resolve)),
      render: vi.fn(),
    };
    let inUse = true;
    const material = new MeshBasicMaterial();
    const warmedUp = warmUpPipelines(renderer as unknown as WebGPURenderer, [material], () => inUse);
    inUse = false;
    compiled();
    await warmedUp;
    expect(renderer.render).not.toHaveBeenCalled();
    // In use: the empty frame compiles the output pass.
    inUse = true;
    const again = warmUpPipelines(renderer as unknown as WebGPURenderer, [material], () => inUse);
    compiled();
    await again;
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });
});
