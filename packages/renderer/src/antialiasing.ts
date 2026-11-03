// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The canvas's anti-aliasing (F397, KB-140) and motion blur (F694). A three.js renderer takes its canvas's
 * multisampling at creation only, so the renderer keeps it (where `RendererOptions.antialias` allows it) and `msaa4`
 * draws to the canvas directly; `none` and `fxaa` draw the scene into a texture without multisampling first, then show
 * it as it is or through an FXAA pass. With motion blur the pass is there for every mode, and a frame of a moving camera
 * is drawn through its blur; a still camera's frames are drawn as without. The passes load with their first use and
 * are ready within a few frames, so a change never stops the frames.
 */
import type { FrameView } from '@vibeglobe/core';
import type { Camera, Scene, WebGPURenderer } from 'three/webgpu';
import type { SinglePass } from './fxaa.js';
import type { motionBlur } from './motion-blur.js';

/** The engine's anti-aliasing modes (`QualitySettings.antialias`). */
export type AntialiasMode = 'none' | 'fxaa' | 'msaa4';

/** The mode of a renderer and the pass that draws it. */
export class Antialiasing {
  #mode: AntialiasMode = 'msaa4';
  /** The motion blur's share of the motion between frames (`QualitySettings.motionBlur`), 0 for none. */
  #blur = 0;
  #pass: SinglePass | undefined;
  #loading: Promise<void> | undefined;
  #disposed = false;
  /** The application's motion blur (`RendererOptions.motionBlur`), without which the blur stays 0. */
  #motion: typeof motionBlur | undefined;

  /**
   * Changes the mode and the blur, drawn with `motion` (`RendererOptions.motionBlur`, without which it stays off); the
   * frames use them once {@link prepare} resolves, the previous ones until then.
   */
  set(mode: AntialiasMode, blur: number, motion?: typeof motionBlur): void {
    this.#motion = motion;
    const share = motion ? blur : 0;
    const rebuild = mode !== this.#mode || share > 0 !== this.#blur > 0;
    this.#mode = mode;
    this.#blur = share;
    if (rebuild) this.release();
  }

  /** Loads the pass the mode needs for this renderer; resolves once frames can use it. */
  prepare(renderer: WebGPURenderer, scene: Scene, camera: Camera): Promise<void> | undefined {
    if (this.#pass || (this.#blur === 0 && this.direct(renderer))) return undefined;
    const mode = this.#mode;
    const blur = this.#blur > 0;
    this.#loading ??= Promise.all([import('./fxaa.js'), blur ? this.#motion?.() : undefined]).then(
      ([{ createSinglePass }, motion]) => {
        this.#loading = undefined;
        if (this.#disposed) return;
        if (this.#mode === mode && this.#blur > 0 === blur && !this.#pass)
          this.#pass = createSinglePass(renderer, scene, camera, mode, motion?.createMotionBlur);
        else return this.prepare(renderer, scene, camera);
      },
    );
    return this.#loading;
  }

  /**
   * Draws the frame: through the blur while the camera moves, through the pass when the mode has one ready, to the
   * canvas directly otherwise. True for a moving camera's frame, after which one more shows the camera at rest sharp.
   */
  render(renderer: WebGPURenderer, scene: Scene, camera: Camera, view: FrameView): boolean {
    const pass = this.#pass;
    if (pass?.moving?.(view, this.#blur)) return true;
    if (pass && !this.direct(renderer)) pass.render();
    else renderer.render(scene, camera);
    return false;
  }

  /** Drops the pass (with its renderer, on a device loss, or for another mode); {@link prepare} loads it again. */
  release(): void {
    this.#pass?.dispose();
    this.#pass = undefined;
  }

  /** Drops the pass for good: the renderer is destroyed, and a pass still loading is never built. */
  dispose(): void {
    this.#disposed = true;
    this.release();
  }

  /**
   * Whether the mode draws to the canvas: `msaa4`, and `none` on a canvas without multisampling
   * (`RendererOptions.antialias` false creates the renderer without); `fxaa` always needs the pass.
   */
  private direct(renderer: WebGPURenderer): boolean {
    return this.#mode === 'msaa4' || (this.#mode === 'none' && renderer.samples === 0);
  }
}
