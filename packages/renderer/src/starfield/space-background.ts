// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import {
  GlobeError,
  type FrameView,
  type Globe,
  type RenderExtension,
  type RenderExtensionContext,
} from '@vibeglobe/core';
import { sunDirectionEcef } from '../atmosphere/sun-position.js';
import type { ThreeExtensionContext } from '../extensions.js';
import { celestialToClip, celestialToEcef, ecefToGalactic } from './sky-orientation.js';
import { skyVisibility } from './sky-visibility.js';
import { DEFAULT_CATALOG_URL, loadStarCatalog } from './star-catalog.js';
import type { StarfieldMeshes } from './starfield-meshes.js';

/** Options of {@link addSpaceBackground}; every one can change later through {@link SpaceBackground.setOptions}. */
export interface SpaceBackgroundOptions {
  /** Shows the background (default true); false hides it without removing it. */
  readonly visible?: boolean;
  /** Draws the stars (default true). */
  readonly stars?: boolean;
  /** Draws the Milky Way (default true). */
  readonly milkyWay?: boolean;
  /** Multiplies the stars' light, 0–8 (default 1). */
  readonly brightness?: number;
  /**
   * The sky's date and time, Unix milliseconds UTC. Unset, the sky follows the engine's (`Globe.atmosphere.timeMs`,
   * a fixed epoch until the application sets one), so the stars agree with the Sun's lighting.
   */
  readonly timeMs?: number;
  /** Fades the background out under the atmosphere's daytime sky near the ground (default true). */
  readonly fade?: boolean;
  /**
   * The halo around the globe seen from space, 0–4 (default 0, none): a soft blue glow beyond the limb, brightest at
   * the edge and fading over a few hundred kilometers, as virtual globes draw it over the atmosphere's thin physical
   * sky (F643). 1 is a virtual globe's; with sun lighting on it shows only on the day side.
   */
  readonly glow?: number;
}

/** What {@link addSpaceBackground} takes: the options, and where the star catalog is hosted. */
export interface SpaceBackgroundInit extends SpaceBackgroundOptions {
  /**
   * The URL of the star catalog `bsc5-stars.bin` (54 KB), an engine asset the application hosts (ADR 0015). By default
   * the file next to the module in the published package, which bundlers copy to the application's assets. It is
   * requested once the background is first drawn, never before.
   */
  readonly catalogUrl?: string;
}

/** The space background added to a globe. */
export interface SpaceBackground {
  /** The options in effect (`timeMs` undefined while the sky follows the engine). */
  readonly options: Readonly<Required<Omit<SpaceBackgroundOptions, 'timeMs'>> & { timeMs: number | undefined }>;
  /** Changes some options; the next frame shows them. `timeMs: undefined` follows the engine's time again. */
  setOptions(options: SpaceBackgroundOptions): void;
  /** The background's opacity in the last frame drawn, 0–1 (0 before the first). */
  readonly visibility: number;
  /** The sky time of the last frame drawn, Unix milliseconds UTC. */
  readonly skyTimeMs: number;
  /** Removes the background and frees its GPU resources. */
  remove(): void;
}

/** The parts of a globe the background reads. */
export type SpaceBackgroundGlobe = Pick<
  Globe,
  'addRenderExtension' | 'atmosphere' | 'qualitySettings' | 'requestRender'
>;

type Settings = SpaceBackground['options'];

function validate(options: SpaceBackgroundOptions): void {
  const { brightness, glow, timeMs } = options;
  if (brightness !== undefined && !(brightness >= 0 && brightness <= 8))
    throw new GlobeError('invalid-option', `brightness must be 0 to 8, got ${String(brightness)}`);
  if (glow !== undefined && !(glow >= 0 && glow <= 4))
    throw new GlobeError('invalid-option', `glow must be 0 to 4, got ${String(glow)}`);
  if (timeMs !== undefined && !Number.isFinite(timeMs))
    throw new GlobeError('invalid-option', `timeMs must be a finite number, got ${String(timeMs)}`);
}

/** The per-frame state of the background, kept across renderer rebuilds; allocates nothing per frame itself. */
class SkyState {
  settings: Settings;
  visibility = 0;
  skyTimeMs = Number.NaN;
  readonly celestial = new Float64Array(9);
  readonly galactic = new Float64Array(9);
  readonly sun = new Float64Array(3);
  readonly clip = new Float32Array(16);
  private readonly scratch = new Float64Array(3);

  constructor(
    private readonly globe: SpaceBackgroundGlobe,
    options: SpaceBackgroundOptions,
  ) {
    validate(options);
    this.settings = {
      visible: true,
      stars: true,
      milkyWay: true,
      brightness: 1,
      fade: true,
      glow: 0,
      timeMs: undefined,
      ...options,
    };
  }

  /** Reads the engine's time and sky, and sets the meshes' uniforms for the frame. */
  update(view: FrameView, meshes: StarfieldMeshes): void {
    const sky = this.globe.atmosphere;
    const timeMs = this.settings.timeMs ?? sky.timeMs;
    if (timeMs !== this.skyTimeMs) {
      celestialToEcef(timeMs, this.celestial);
      ecefToGalactic(timeMs, this.galactic);
      sunDirectionEcef(timeMs, this.sun);
      this.skyTimeMs = timeMs;
    }
    this.visibility = skyVisibility({
      eyeEcef: view.eyeEcef,
      sunEcef: sky.sunLighting ? this.sun : undefined,
      atmosphere: this.globe.qualitySettings.atmosphere !== 'off',
      morph: view.morph.morph,
      fade: this.settings.fade,
    });
    const u = meshes.uniforms;
    const shown = this.settings.visible && this.visibility > 0;
    meshes.stars.visible = shown && this.settings.stars;
    meshes.milkyWay.visible = shown;
    u.milkyWay.value = this.settings.milkyWay ? 1 : 0;
    u.visibility.value = this.visibility;
    u.brightness.value = this.settings.brightness;
    u.glow.value = this.settings.glow;
    u.sunLit.value = sky.sunLighting ? 1 : 0;
    this.galacticOf(view.eyeEcef, 0.001, u.eyeKm.value);
    this.galacticOf(this.sun, 1, u.sun.value);
    u.pixelRatio.value = view.pixelRatio;
    u.bufferPx.value.set(Math.max(1, view.widthPx * view.pixelRatio), Math.max(1, view.heightPx * view.pixelRatio));
    u.celestialToClip.value.fromArray(celestialToClip(view.view, view.projection, this.celestial, this.clip));
    this.setRays(view, meshes);
  }

  /**
   * The galactic ray of a pixel is linear in its normalized device coordinates, as the atmosphere's sky computes it:
   * (x + P8) / P0 and (y + P9) / P5 at view z = −1, rotated into ECEF by the transposed view, then into galactic axes.
   */
  private setRays(view: FrameView, meshes: StarfieldMeshes): void {
    const p = view.projection;
    const p0 = p[0] ?? 1;
    const p5 = p[5] ?? 1;
    const u = meshes.uniforms;
    this.ray(view.view, (p[8] ?? 0) / p0, (p[9] ?? 0) / p5, -1, u.rayCenter.value);
    this.ray(view.view, 1 / p0, 0, 0, u.rayX.value);
    this.ray(view.view, 0, 1 / p5, 0, u.rayY.value);
  }

  private ray(
    v: Float64Array,
    x: number,
    y: number,
    z: number,
    out: { set(x: number, y: number, z: number): void },
  ): void {
    const e = this.scratch;
    for (let i = 0; i < 3; i++) e[i] = (v[i * 4] ?? 0) * x + (v[i * 4 + 1] ?? 0) * y + (v[i * 4 + 2] ?? 0) * z;
    this.galacticOf(e, 1, out);
  }

  /** An ECEF vector in galactic axes, times `scale`. */
  private galacticOf(e: ArrayLike<number>, scale: number, out: { set(x: number, y: number, z: number): void }): void {
    const g = this.galactic;
    const at = (row: number): number =>
      ((g[row * 3] ?? 0) * (e[0] ?? 0) + (g[row * 3 + 1] ?? 0) * (e[1] ?? 0) + (g[row * 3 + 2] ?? 0) * (e[2] ?? 0)) *
      scale;
    out.set(at(0), at(1), at(2));
  }
}

/** The render extension: its meshes are built once three.js and the catalog are loaded, then updated every frame. */
/** Fetches a URL's bytes, failing on an HTTP error. */
async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.arrayBuffer();
}

/**
 * The render extension: its meshes are built once three.js and the catalog are loaded (both on first use), then
 * updated every frame.
 */
function spaceExtension(state: SkyState, catalogUrl: string, context: RenderExtensionContext): RenderExtension {
  const three = context.renderer as ThreeExtensionContext;
  let meshes: StarfieldMeshes | undefined;
  let disposed = false;
  Promise.all([import('./starfield-meshes.js'), loadStarCatalog(catalogUrl, fetchBytes)]).then(
    ([{ createStarfieldMeshes }, catalog]) => {
      if (disposed) return;
      meshes = createStarfieldMeshes(catalog, three.depthPath());
      three.scene.add(meshes.milkyWay, meshes.stars);
      context.requestRender();
    },
    (error: unknown) =>
      context.report(
        new GlobeError('resource-failed', `The space background's star catalog failed to load from ${catalogUrl}`, {
          cause: error,
        }),
      ),
  );
  return {
    frame(view) {
      if (meshes) state.update(view, meshes);
    },
    dispose() {
      disposed = true;
      meshes?.dispose();
      meshes = undefined;
    },
  };
}

/**
 * Adds a space background like a virtual globe's (ADR 0181): the 9,096 stars of the Yale Bright Star Catalog and a
 * procedural Milky Way behind the globe, fixed in the celestial frame, so every camera move, globe spin or tilt turns
 * the sky with it, and rotated by Greenwich sidereal time from the engine's date and time. Stars are crisp at any pixel
 * ratio and do not shimmer; the background fades out under the atmosphere's daytime sky near the ground and shows
 * again at night or from space; a halo around the globe seen from space if asked (`glow`). Off unless added; call once
 * the globe is ready (`Globe.addRenderExtension`).
 */
export function addSpaceBackground(globe: SpaceBackgroundGlobe, init: SpaceBackgroundInit = {}): SpaceBackground {
  const { catalogUrl = DEFAULT_CATALOG_URL(), ...options } = init;
  const state = new SkyState(globe, options);
  const remove = globe.addRenderExtension((context) => spaceExtension(state, catalogUrl, context));
  return {
    get options() {
      return { ...state.settings };
    },
    setOptions(changes) {
      validate(changes);
      state.settings = { ...state.settings, ...changes };
      globe.requestRender();
    },
    get visibility() {
      return state.visibility;
    },
    get skyTimeMs() {
      return state.skyTimeMs;
    },
    remove,
  };
}
