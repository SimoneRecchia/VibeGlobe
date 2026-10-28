/* This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
 * distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { Scene, type Texture } from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LayerBatches } from './layer-batches.js';

/** The atlas's 2D canvas: Node has none, and nothing is drawn into it here. */
class StubCanvas {
  width = 0;
  height = 0;
  getContext(): object {
    return {};
  }
}

describe('LayerBatches.restore', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('gives the atlas a new texture of the same image, so the lost renderer listening to the old one is not kept (KB-222)', () => {
    vi.stubGlobal('OffscreenCanvas', StubCanvas);
    const batches = new LayerBatches(new Scene(), 'reversed-z');
    const atlas = (batches as unknown as { atlas: { texture: Texture } }).atlas;
    const lost = atlas.texture;
    // A disposed renderer no longer removes the listener it added: the texture holding it must not be kept.
    const listener = (): void => undefined;
    lost.addEventListener('dispose', listener);
    batches.restore('reversed-z');
    expect(atlas.texture).not.toBe(lost);
    expect(atlas.texture.hasEventListener('dispose', listener)).toBe(false);
    expect(atlas.texture.image).toBe(lost.image);
    expect(atlas.texture.version).toBeGreaterThan(0);
  });
});
