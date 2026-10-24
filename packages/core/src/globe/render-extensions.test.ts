import { describe, expect, it } from 'vitest';
import type { Credit } from '../imagery/credits.js';
import { addExtension, type RenderExtension, type RenderExtensionContext } from './render-extensions.js';
import { refuseDisplayOnlySource, refuseExtensionReadback } from './display-only.js';
import { runtimeCredits } from './runtime-credits.js';
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

  it("merges the credits an extension sets into the globe's, its provider's required credit pinned, until removed (track E hook 2)", () => {
    const shown: (readonly Credit[])[] = [];
    const renderer = {
      host: { showCredits: (credits: readonly Credit[]) => void shown.push(credits) },
      extensions: { context: {}, add: () => () => undefined },
    } as unknown as RendererBackend;
    const changes: (readonly Credit[])[] = [];
    const credits = runtimeCredits(
      [],
      -1,
      renderer,
      { requestFrame: () => undefined, tileError: () => undefined, creditsChange: (c) => void changes.push(c) },
      undefined,
    );
    let context: RenderExtensionContext | undefined;
    const imagery = { network: {}, lease: { pool: {} }, credits } as unknown as Parameters<typeof addExtension>[3];
    const remove = addExtension(
      renderer,
      (given) => ((context = given), { frame: () => undefined, dispose: () => undefined }),
      () => undefined,
      imagery,
    );
    const logo = { src: 'google.svg', alt: 'Google' };
    context?.setCredits([
      {
        id: 'google-3d',
        attribution: [{ text: 'Data SIO, NOAA' }],
        profile: { id: 'google', requiredAttribution: { text: 'Google', logo } },
      },
    ]);
    expect(credits.list().map((c) => [c.text, c.required, c.logo !== undefined])).toEqual([
      ['Google', true, true],
      ['Data SIO, NOAA', false, false],
    ]);
    expect(changes.at(-1)?.map((c) => c.text)).toEqual(['Google', 'Data SIO, NOAA']);
    expect(shown.at(-1)?.map((c) => c.text)).toEqual(['Google', 'Data SIO, NOAA']);
    remove();
    expect(credits.list()).toEqual([]);
    expect(changes.at(-1)).toEqual([]);
  });

  it('refuses pixel readback while an extension draws a display-only source, and its own data access (hook E6)', () => {
    const renderer = { extensions: { context: {}, add: () => () => undefined } } as unknown as RendererBackend;
    let context: RenderExtensionContext | undefined;
    const remove = addExtension(
      renderer,
      (given) => ((context = given), { frame: () => undefined, dispose: () => undefined }),
      () => undefined,
    );
    const google = { id: 'google-3d', profile: { id: 'google', displayOnly: true } };
    expect(() => refuseExtensionReadback('captureFrame', renderer)).not.toThrow();
    context?.setCredits([google]);
    expect(() => refuseExtensionReadback('captureFrame', renderer)).toThrowError(
      /captureFrame is refused: source 'google-3d'/,
    );
    expect(() => refuseDisplayOnlySource('pickTile', google)).toThrowError(/display only under the 'google' profile/);
    remove();
    expect(() => refuseExtensionReadback('captureFrame', renderer)).not.toThrow();
  });
});
