import { describe, expect, it } from 'vitest';
import { addExtension, type RenderExtension } from './render-extensions.js';
import type { RendererBackend } from './types.js';

describe('render extensions (M13 hook)', () => {
  it('creates an extension with the renderer context, adds it, asks for frames, and disposes it on removal', () => {
    const added: RenderExtension[] = [];
    const renderer = {
      extensions: {
        context: { scene: 'scene' },
        add: (extension: RenderExtension) => {
          added.push(extension);
          return () => extension.dispose();
        },
      },
    } as unknown as RendererBackend;
    let frames = 0;
    let disposed = 0;
    let context: unknown;
    const remove = addExtension(
      renderer,
      (given) => ((context = given.renderer), { frame: () => undefined, dispose: () => void disposed++ }),
      () => void frames++,
    );
    expect(context).toEqual({ scene: 'scene' });
    expect([added.length, frames]).toEqual([1, 1]);
    remove();
    expect([disposed, frames]).toEqual([1, 2]);
  });

  it('refuses before the renderer is ready, or on a renderer without extensions', () => {
    const create = (): RenderExtension => ({ frame: () => undefined, dispose: () => undefined });
    expect(() => addExtension(undefined, create, () => undefined)).toThrowError(/once the globe is ready/);
    expect(() => addExtension({} as RendererBackend, create, () => undefined)).toThrowError(/once the globe is ready/);
  });
});
