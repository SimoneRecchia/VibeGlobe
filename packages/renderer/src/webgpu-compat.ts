let patched = false;

/**
 * three.js 0.186 always passes `swizzle: 'rgba'` (the identity) in texture-view descriptors. Chromium releases that
 * predate the string form of that member reject it and the renderer crashes on its first texture. Dropping only the
 * identity value changes nothing on browsers that accept it and lets older ones run. Applied once, on first use.
 */
export function patchIdentitySwizzle(view: Window): void {
  const prototype = (view as Window & { GPUTexture?: { prototype: GPUTexture } }).GPUTexture?.prototype;
  if (patched || !prototype) return;
  patched = true;
  const createView = prototype.createView;
  prototype.createView = function (this: GPUTexture, descriptor?: GPUTextureViewDescriptor): GPUTextureView {
    if (descriptor && (descriptor as { swizzle?: unknown }).swizzle === 'rgba') {
      const rest: GPUTextureViewDescriptor & { swizzle?: unknown } = { ...descriptor };
      delete rest.swizzle;
      return createView.call(this, rest);
    }
    return createView.call(this, descriptor);
  };
}
