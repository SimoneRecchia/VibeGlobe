import { describe, expect, it } from 'vitest';
import { requestingTarget } from './layer-geometry.js';
import type { LayerRenderTarget } from './layer-target.js';
import type { ModelRenderer } from './models.js';

describe('requestingTarget', () => {
  it("forwards a model renderer's joint angles with a frame and its drawn count without one (F648)", () => {
    const calls: string[] = [];
    const models: ModelRenderer = {
      load: () => Promise.resolve(1),
      setPose: () => undefined,
      remove: () => undefined,
      setInstanceAngles: (id, joint) => void calls.push(`angles ${String(id)} ${String(joint)}`),
      drawnInstances: (id) => id * 10,
    };
    let frames = 0;
    const target = requestingTarget({ models } as unknown as LayerRenderTarget, () => void frames++);
    const wrapped = target?.models;
    wrapped?.setInstanceAngles?.(7, 1, new Float32Array(2));
    expect(calls).toEqual(['angles 7 1']);
    expect(frames).toBe(1);
    expect(wrapped?.drawnInstances?.(3)).toBe(30);
    expect(frames).toBe(1);
    // Calls the renderer lacks stay absent.
    expect(wrapped?.setHighlight).toBeUndefined();
  });
});
