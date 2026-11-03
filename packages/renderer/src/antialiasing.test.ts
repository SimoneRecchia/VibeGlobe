import type { FrameView } from '@vibeglobe/core';
import { PassNode, RenderPipeline, PerspectiveCamera, Scene, type WebGPURenderer } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import { Antialiasing } from './antialiasing.js';
import { createSinglePass } from './fxaa.js';
import { motionBlur } from './motion-blur.js';

describe('anti-aliasing passes', () => {
  it("frees the pass's render target with the pass", () => {
    const disposed = vi.spyOn(PassNode.prototype, 'dispose');
    const pass = createSinglePass({} as WebGPURenderer, new Scene(), new PerspectiveCamera(), 'fxaa');
    pass.dispose();
    expect(disposed).toHaveBeenCalledTimes(1);
    disposed.mockRestore();
  });

  it('builds no pass for a renderer disposed while the pass was loading', async () => {
    const antialiasing = new Antialiasing();
    antialiasing.set('fxaa', 0);
    const renderer = { samples: 0 } as WebGPURenderer;
    const loading = antialiasing.prepare(renderer, new Scene(), new PerspectiveCamera());
    antialiasing.dispose();
    await loading;
    const render = vi.fn();
    antialiasing.render({ render } as unknown as WebGPURenderer, new Scene(), new PerspectiveCamera(), {} as FrameView);
    // No pass: the frame goes to the renderer directly.
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("draws a moving camera's frames through the motion blur and a still camera's to the canvas, as without (F694)", async () => {
    const drawn = vi.spyOn(RenderPipeline.prototype, 'render').mockImplementation(() => undefined);
    const antialiasing = new Antialiasing();
    antialiasing.set('msaa4', 0.5, motionBlur);
    const render = vi.fn();
    const renderer = { samples: 4, render } as unknown as WebGPURenderer;
    await antialiasing.prepare(renderer, new Scene(), new PerspectiveCamera());
    const view = { view: new Float64Array(16), projection: new Float64Array(16), eyeEcef: new Float64Array(3) };
    const frame = () => antialiasing.render(renderer, new Scene(), new PerspectiveCamera(), view as FrameView);
    expect([frame(), drawn.mock.calls.length, render.mock.calls.length]).toEqual([true, 1, 0]);
    expect([frame(), drawn.mock.calls.length, render.mock.calls.length]).toEqual([false, 1, 1]);
    antialiasing.dispose();
    drawn.mockRestore();
  });
});
