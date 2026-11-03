// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { AtmosphereSettings, DepthPath, FrameView, RendererQuality } from '@vibeglobe/core';
import type { MeshBasicNodeMaterial, Object3D, Scene } from 'three/webgpu';
import { Atmosphere, createAtmosphereFrame, globeFrame, morphFrame } from './atmosphere.js';
import { ATMOSPHERE_QUALITY } from './atmosphere-model.js';

const OFF: RendererQuality = { anisotropy: 1, antialias: 'none', atmosphere: 'off', fog: true };

/**
 * The atmosphere of a backend's scene (ADR 0040; the "Atmosphere hook" of docs/internal/parallel-tracks.md): created while the
 * quality's atmosphere level is not 'off', its sky in the scene, its settings kept for a rebuild after a device loss,
 * and its frame from the engine's view, the globe's or, during the morph, blended toward the flat map (F393).
 */
export class SceneAtmosphere {
  private atmosphere: Atmosphere | undefined;
  private quality = OFF;
  private sky: Required<AtmosphereSettings> | undefined;
  private readonly globe = createAtmosphereFrame();
  private readonly frame = createAtmosphereFrame();
  private readonly up = new Float64Array(3);

  constructor(private readonly scene: Scene) {}

  /** The atmosphere the surface material shades with, if any. */
  get current(): Atmosphere | undefined {
    return this.atmosphere;
  }

  /** The sky's material, to compile with the surface's before the first frame. */
  get skyMaterial(): MeshBasicNodeMaterial | undefined {
    return this.atmosphere?.sky.material as MeshBasicNodeMaterial | undefined;
  }

  /** Applies a quality; returns true when the atmosphere appeared or went away, so the surface material is rebuilt. */
  setQuality(quality: RendererQuality, depthPath: DepthPath): boolean {
    const toggled = (quality.atmosphere === 'off') !== (this.quality.atmosphere === 'off');
    this.quality = quality;
    if (toggled) this.rebuild(depthPath);
    else this.applyOptions();
    return toggled;
  }

  /** Sun lighting, time and haze. */
  setSky(settings: Required<AtmosphereSettings>): void {
    this.sky = settings;
    this.applyOptions();
  }

  /** Creates the atmosphere again for a depth path (a new renderer), or removes it while its level is 'off'. */
  rebuild(depthPath: DepthPath): void {
    this.dispose();
    if (this.quality.atmosphere === 'off') return;
    this.atmosphere = new Atmosphere(depthPath);
    this.scene.add(this.atmosphere.sky);
    this.applyOptions();
  }

  /** Sets this frame's uniforms (allocates nothing). */
  update(view: FrameView): void {
    const atmosphere = this.atmosphere;
    if (!atmosphere) return;
    const morph = view.morph.morph;
    if (morph <= 0) return atmosphere.update(view);
    // During the morph: the globe's altitude and zenith under the eye blended with the flat map's at the anchor.
    const globe = globeFrame(view.eyeEcef, this.globe);
    const axes = view.morph.axes;
    const anchor = view.morph.anchorEcef;
    let planeHeight = 0;
    for (let i = 0; i < 3; i++) {
      const anchorUp = axes[6 + i] ?? 0;
      planeHeight += ((view.eyeEcef[i] ?? 0) - (anchor[i] ?? 0)) * anchorUp;
      this.up[i] = (1 - morph) * (globe.up[i] ?? 0) + morph * anchorUp;
    }
    const height = (1 - morph) * globe.eyeAltitudeM + morph * planeHeight;
    atmosphere.update(view, morphFrame(morph, height, this.up, this.frame));
  }

  /**
   * Adds a surface mesh to the scene before the sky: the engine draws in scene order, and the sky, which draws only
   * where nothing did, then skips the pixels the globe covers instead of ray-marching under every one of them.
   */
  addBelowSky(mesh: Object3D): void {
    this.scene.add(mesh);
    const children = this.scene.children;
    const sky = this.atmosphere ? children.indexOf(this.atmosphere.sky) : -1;
    if (sky < 0) return;
    children.pop();
    children.splice(sky, 0, mesh);
  }

  /** Removes the sky from the scene and frees it. */
  dispose(): void {
    if (!this.atmosphere) return;
    this.scene.remove(this.atmosphere.sky);
    this.atmosphere.dispose();
    this.atmosphere = undefined;
  }

  private applyOptions(): void {
    const level = this.quality.atmosphere;
    if (!this.atmosphere || level === 'off') return;
    const samples = ATMOSPHERE_QUALITY[level];
    // Without fog the surface marches no haze; sun lighting still shades it.
    this.atmosphere.setOptions({
      quality: this.quality.fog ? samples : { ...samples, surfaceSamples: 0 },
      ...(this.sky ?? {}),
    });
  }
}
