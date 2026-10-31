import { PassNode, PerspectiveCamera, Scene, type WebGPURenderer } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import { Antialiasing } from './antialiasing.js';
import { createSinglePass } from './fxaa.js';

describe('anti-aliasing passes', () => {
  it("frees the pass's render target with the pass", () => {
    const disposed = vi.spyOn(PassNode.prototype, 'dispose');
    const pass = createSinglePass({} as WebGPURenderer, new Scene(), new PerspectiveCamera(), true);
    pass.dispose();
    expect(disposed).toHaveBeenCalledTimes(1);
    disposed.mockRestore();
  });

  it('builds no pass for a renderer disposed while the pass was loading', async () => {
    const antialiasing = new Antialiasing();
    antialiasing.set('fxaa');
    const renderer = { samples: 0 } as WebGPURenderer;
    const loading = antialiasing.prepare(renderer, new Scene(), new PerspectiveCamera());
    antialiasing.dispose();
    await loading;
    const render = vi.fn();
    antialiasing.render({ render } as unknown as WebGPURenderer, new Scene(), new PerspectiveCamera());
    // No pass: the frame goes to the renderer directly.
    expect(render).toHaveBeenCalledTimes(1);
  });
});
