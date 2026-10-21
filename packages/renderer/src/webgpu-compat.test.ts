import { describe, expect, it } from 'vitest';
import { patchIdentitySwizzle } from './webgpu-compat.js';

describe('patchIdentitySwizzle', () => {
  it('drops the identity swizzle without copying the descriptor, which three.js builds every frame (KB-026)', () => {
    const received: (GPUTextureViewDescriptor | undefined)[] = [];
    class FakeTexture {
      createView(descriptor?: GPUTextureViewDescriptor): GPUTextureView {
        received.push(descriptor);
        return {} as GPUTextureView;
      }
    }
    patchIdentitySwizzle({ GPUTexture: FakeTexture } as unknown as typeof globalThis);
    const texture = new FakeTexture();
    const identity = { dimension: '2d', swizzle: 'rgba' } as GPUTextureViewDescriptor;
    const other = { dimension: '2d', swizzle: 'bgra' } as GPUTextureViewDescriptor;
    texture.createView(identity);
    texture.createView(other);
    texture.createView();
    expect(received[0]).toBe(identity);
    expect((received[0] as { swizzle?: unknown }).swizzle).toBeUndefined();
    expect(received[1]).toBe(other);
    expect((received[1] as { swizzle?: unknown }).swizzle).toBe('bgra');
    expect(received[2]).toBeUndefined();
  });
});
