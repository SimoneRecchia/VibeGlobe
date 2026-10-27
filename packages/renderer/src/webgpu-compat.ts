// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
let patched = false;

/**
 * three.js 0.186 always passes `swizzle: 'rgba'` (the identity) in texture-view descriptors. Chromium releases that
 * predate the string form of that member reject it and the renderer crashes on its first texture. Dropping only the
 * identity value changes nothing on browsers that accept it and lets older ones run. Applied once, on first use.
 */
export function patchIdentitySwizzle(scope: typeof globalThis): void {
  const prototype = (scope as { GPUTexture?: { prototype: GPUTexture } }).GPUTexture?.prototype;
  if (patched || !prototype) return;
  patched = true;
  const createView = prototype.createView;
  prototype.createView = function (this: GPUTexture, descriptor?: GPUTextureViewDescriptor): GPUTextureView {
    // three.js builds a new descriptor for every call, the canvas view included (once per frame), so the member is
    // cleared in place: a copy would allocate every frame (KB-026, ADR 0018). WebIDL treats undefined as absent.
    const members = descriptor as { swizzle?: unknown } | undefined;
    if (members?.swizzle === 'rgba') members.swizzle = undefined;
    return createView.call(this, descriptor);
  };
}
