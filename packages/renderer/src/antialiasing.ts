/**
 * The canvas's anti-aliasing (F397, KB-140). A three.js renderer takes its canvas's multisampling at creation only, so
 * the renderer keeps it (where `RendererOptions.antialias` allows it) and `msaa4` draws to the canvas directly; `none`
 * and `fxaa` draw the scene into a texture without multisampling first, then show it as it is or through an FXAA pass.
 * The pass loads with its first use and is ready within a few frames, so a change never stops the frames.
 */
import type { Camera, Scene, WebGPURenderer } from 'three/webgpu';
import type { SinglePass } from './fxaa.js';

/** The engine's anti-aliasing modes (`QualitySettings.antialias`). */
export type AntialiasMode = 'none' | 'fxaa' | 'msaa4';

/** The mode of a renderer and the pass that draws it. */
export class Antialiasing {
  #mode: AntialiasMode = 'msaa4';
  #pass: SinglePass | undefined;
  #loading: Promise<void> | undefined;

  /** Changes the mode; the frames use it once {@link prepare} resolves, the previous mode's until then. */
  set(mode: AntialiasMode): void {
    if (mode === this.#mode) return;
    this.#mode = mode;
    this.release();
  }

  /** Loads the pass the mode needs for this renderer; resolves once frames can use it. */
  prepare(renderer: WebGPURenderer, scene: Scene, camera: Camera): Promise<void> | undefined {
    if (this.#pass || !this.needsPass(renderer)) return undefined;
    const mode = this.#mode;
    this.#loading ??= import('./fxaa.js').then(({ createSinglePass }) => {
      this.#loading = undefined;
      if (this.#mode === mode && !this.#pass) this.#pass = createSinglePass(renderer, scene, camera, mode === 'fxaa');
      else return this.prepare(renderer, scene, camera);
    });
    return this.#loading;
  }

  /** Draws the frame: through the pass when the mode has one ready, to the canvas directly otherwise. */
  render(renderer: WebGPURenderer, scene: Scene, camera: Camera): void {
    if (this.#pass) this.#pass.render();
    else renderer.render(scene, camera);
  }

  /** Drops the pass (with its renderer, on a device loss, or for another mode); {@link prepare} loads it again. */
  release(): void {
    this.#pass?.dispose();
    this.#pass = undefined;
  }

  /**
   * `fxaa` always; `none` only to leave out a multisampled canvas (`RendererOptions.antialias` false creates the
   * renderer without, and then needs no pass).
   */
  private needsPass(renderer: WebGPURenderer): boolean {
    return this.#mode === 'fxaa' || (this.#mode === 'none' && renderer.samples > 0);
  }
}
