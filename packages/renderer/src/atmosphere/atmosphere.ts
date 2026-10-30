// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { DepthPath, FrameView } from '@vibeglobe/core';
import { float, positionGeometry, varying, vec3, vec4 } from 'three/tsl';
import {
  BufferAttribute,
  BufferGeometry,
  GreaterEqualDepth,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  type NodeMaterial,
} from 'three/webgpu';
import { ATMOSPHERE, ATMOSPHERE_QUALITY, surfaceVisibility, type AtmosphereQuality } from './atmosphere-model.js';
import { createAtmosphereUniforms, skyColor, surfaceColor, type AtmosphereUniforms } from './atmosphere-nodes.js';
import { sunDirectionEcef } from './sun-position.js';

/** The atmosphere's settings; every one can change at runtime, with no shader rebuild (F396, F399). */
export interface AtmosphereOptions {
  /** Shades the globe and terrain by the Sun at {@link AtmosphereOptions.timeMs}; off by default (F396). */
  readonly sunLighting: boolean;
  /** The date and time the Sun's position is computed for, Unix milliseconds (UTC). */
  readonly timeMs: number;
  /** Aerosol density relative to a clear day: more haze hides more of the distance. */
  readonly haze: number;
  /** Day and night's strength, 0 to 1 (F647). */
  readonly dayNight: number;
  /** Scales the light the air scatters toward the eye over the ground (F647). */
  readonly airlight: number;
  readonly quality: AtmosphereQuality;
}

const DEFAULT_OPTIONS: AtmosphereOptions = {
  sunLighting: false,
  timeMs: Date.UTC(2026, 5, 21, 12),
  haze: 1,
  dayNight: 0,
  airlight: 1,
  quality: ATMOSPHERE_QUALITY.high,
};

/**
 * Where the atmosphere's sphere is relative to the eye, written by {@link globeFrame} and {@link morphFrame}: during
 * the globe-to-flat morph (F393) the engine passes its own blend, and the atmosphere follows it with no jump.
 */
export interface AtmosphereFrame {
  /** The eye's altitude above the sphere, meters. */
  eyeAltitudeM: number;
  /** The sphere's radius, meters: the globe's, and growing as the view morphs flat. */
  radiusM: number;
  /** The eye's zenith, world axes, unit length. */
  readonly up: Float64Array;
  /** Scales world axes into the sphere's space: (1, 1, a / b) on the globe. */
  readonly axisScale: Float64Array;
}

/** Creates a frame to pass to {@link globeFrame} or {@link morphFrame} each frame. */
export function createAtmosphereFrame(): AtmosphereFrame {
  return {
    eyeAltitudeM: 0,
    radiusM: ATMOSPHERE.radiusKm * 1000,
    up: new Float64Array([0, 0, 1]),
    axisScale: new Float64Array([1, 1, ATMOSPHERE.polarScale]),
  };
}

/**
 * The frame of a globe view from its eye in ECEF meters: the polar axis scaled by a / b turns the WGS84 ellipsoid into
 * a sphere of radius a (ADR 0040), so the altitude is measured above the ellipsoid along the scaled radius.
 */
export function globeFrame(eyeEcef: ArrayLike<number>, out: AtmosphereFrame): AtmosphereFrame {
  const x = eyeEcef[0] ?? 0;
  const y = eyeEcef[1] ?? 0;
  const z = (eyeEcef[2] ?? 0) * ATMOSPHERE.polarScale;
  const distance = Math.hypot(x, y, z) || 1;
  out.radiusM = ATMOSPHERE.radiusKm * 1000;
  out.eyeAltitudeM = distance - out.radiusM;
  out.up[0] = x / distance;
  out.up[1] = y / distance;
  out.up[2] = z / distance;
  out.axisScale[0] = 1;
  out.axisScale[1] = 1;
  out.axisScale[2] = ATMOSPHERE.polarScale;
  return out;
}

const visibilityFrame = createAtmosphereFrame();
const visibilityRay = { eyeAltitudeKm: 0, radiusKm: 0, viewMu: 0, maxDistanceKm: 0 };

/**
 * {@link surfaceVisibility} of an ECEF point seen from an ECEF eye on the globe, both in meters: the factor the engine
 * multiplies a tile's screen-space error by, for the tile's nearest point (F395). Allocates nothing.
 */
export function ecefVisibility(eyeEcef: ArrayLike<number>, pointEcef: ArrayLike<number>, haze = 1): number {
  const frame = globeFrame(eyeEcef, visibilityFrame);
  const dx = (pointEcef[0] ?? 0) - (eyeEcef[0] ?? 0);
  const dy = (pointEcef[1] ?? 0) - (eyeEcef[1] ?? 0);
  const dz = ((pointEcef[2] ?? 0) - (eyeEcef[2] ?? 0)) * ATMOSPHERE.polarScale;
  const distance = Math.hypot(dx, dy, dz);
  if (distance === 0) return 1;
  visibilityRay.eyeAltitudeKm = frame.eyeAltitudeM / 1000;
  visibilityRay.radiusKm = frame.radiusM / 1000;
  visibilityRay.viewMu = (dx * (frame.up[0] ?? 0) + dy * (frame.up[1] ?? 0) + dz * (frame.up[2] ?? 0)) / distance;
  visibilityRay.maxDistanceKm = distance / 1000;
  return surfaceVisibility(visibilityRay, haze);
}

/** The largest radius a flat view uses, as a multiple of the globe's: curvature beyond it is below a pixel. */
const FLAT_RADIUS_FACTOR = 1000;

/**
 * Blends a frame toward the flat map (F393): `flatness` 0 keeps the globe, 1 is flat. The engine passes the eye's
 * height above its morphed surface and that surface's up direction under the eye; the sphere's radius grows as
 * 1 / (1 − flatness)², so curvature fades continuously, and the polar scale fades to none.
 */
export function morphFrame(
  flatness: number,
  eyeHeightM: number,
  upWorld: ArrayLike<number>,
  out: AtmosphereFrame,
): AtmosphereFrame {
  const t = Math.min(1, Math.max(0, flatness));
  const radius = ATMOSPHERE.radiusKm * 1000;
  // Curvature (1 − t)² / R: the horizon's dip below the eye, about √(2h·curvature), then shrinks linearly in t.
  out.radiusM = Math.min(radius / Math.max((1 - t) * (1 - t), 1e-9), radius * FLAT_RADIUS_FACTOR);
  out.eyeAltitudeM = eyeHeightM;
  const ux = upWorld[0] ?? 0;
  const uy = upWorld[1] ?? 0;
  const uz = upWorld[2] ?? 1;
  const length = Math.hypot(ux, uy, uz) || 1;
  out.up[0] = ux / length;
  out.up[1] = uy / length;
  out.up[2] = uz / length;
  out.axisScale[0] = 1;
  out.axisScale[1] = 1;
  out.axisScale[2] = 1 + (ATMOSPHERE.polarScale - 1) * (1 - t);
  return out;
}

/**
 * The sky, haze, fog and sun lighting of a view (ADR 0040; F391–F396). The engine adds {@link Atmosphere.sky} to its
 * scene, builds its surface material's color through {@link Atmosphere.surfaceColor}, and calls
 * {@link Atmosphere.update} before each render. Options change uniforms only, so no pipeline is rebuilt at runtime.
 */
export class Atmosphere {
  /** A full-screen triangle drawn where no surface wrote depth, behind everything. */
  readonly sky: Mesh;
  private readonly uniforms: AtmosphereUniforms = createAtmosphereUniforms();
  private options: AtmosphereOptions = DEFAULT_OPTIONS;
  private readonly frame = createAtmosphereFrame();
  private readonly sunEcef = new Float64Array(3);
  /** Preallocated: {@link Atmosphere.update} allocates nothing (ADR 0018). */
  private readonly scratch = new Float64Array(3);
  private sunTimeMs = Number.NaN;

  constructor(depthPath: DepthPath) {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const material = new MeshBasicNodeMaterial();
    const u = this.uniforms;
    const ndc = positionGeometry.xy;
    const ray = varying(
      vec3(u.rayCenter as unknown as Node<'vec3'>)
        .add((u.rayX as unknown as Node<'vec3'>).mul(ndc.x))
        .add((u.rayY as unknown as Node<'vec3'>).mul(ndc.y)),
    );
    // Depth 0 is the far end on every path (ADR 0005): the sky passes the greater-equal test only where nothing drew.
    material.vertexNode = vec4(ndc, 0, 1);
    material.colorNode = skyColor(u, ray);
    material.depthWrite = false;
    if (depthPath === 'fragment') {
      material.depthNode = float(0);
      material.depthFunc = GreaterEqualDepth;
    }
    this.sky = new Mesh(geometry, material);
    this.sky.frustumCulled = false;
    this.sky.matrixAutoUpdate = false;
    this.sky.matrixWorldAutoUpdate = false;
    this.sky.name = 'atmosphere-sky';
    this.setOptions({});
  }

  /** Changes some options; the next {@link Atmosphere.update} applies them. */
  setOptions(options: Partial<AtmosphereOptions>): void {
    this.options = { ...this.options, ...options };
    const u = this.uniforms;
    u.haze.value = this.options.haze;
    u.lighting.value = this.options.sunLighting ? 1 : 0;
    u.dayNight.value = this.options.dayNight;
    u.airlight.value = this.options.airlight;
    u.skySamples.value = this.options.quality.skySamples;
    u.surfaceSamples.value = this.options.quality.surfaceSamples;
    u.dither.value = this.options.quality.dither ? 1 : 0;
  }

  /** The current options. */
  get currentOptions(): AtmosphereOptions {
    return this.options;
  }

  /**
   * Wraps a surface material's color (linear RGB) in the haze and sun lighting; `eyeRelative` is the fragment's position
   * relative to the eye in meters, world axes, as the surface's vertex stage computes it (`eyeRelativePosition`), and
   * `reliefMeters` the terrain height it was raised by, whose slopes the Sun shades.
   */
  surfaceColor(
    color: Node<'vec3'>,
    eyeRelative: Node<'vec3'>,
    reliefMeters?: Node<'float'>,
    night?: Node<'vec3'>,
  ): Node<'vec3'> {
    return surfaceColor(this.uniforms, color, varying(eyeRelative), reliefMeters && varying(reliefMeters), night);
  }

  /**
   * Applies {@link Atmosphere.surfaceColor} to a material whose color node is set and whose vertices are eye-relative;
   * `night` is the light of its night imagery (F647).
   */
  applyToSurface(
    material: NodeMaterial,
    eyeRelative: Node<'vec3'>,
    reliefMeters?: Node<'float'>,
    night?: Node<'vec3'>,
  ): void {
    const color = material.colorNode as Node<'vec4'> | null;
    if (!color) return;
    material.colorNode = vec4(this.surfaceColor(color.xyz, eyeRelative, reliefMeters, night), color.w);
  }

  /**
   * Sets this frame's uniforms from the engine's view: the sky rays from the matrices, the eye's frame (the globe's
   * from the eye position unless the engine passes a morph frame), and the Sun, which without sun lighting stands
   * behind the eye so the whole visible side is lit.
   */
  update(view: FrameView, frame?: AtmosphereFrame): void {
    const f = frame ?? globeFrame(view.eyeEcef, this.frame);
    const u = this.uniforms;
    u.eyeAltitudeKm.value = Math.max(0, f.eyeAltitudeM) / 1000;
    u.radiusKm.value = f.radiusM / 1000;
    u.up.value.set(f.up[0] ?? 0, f.up[1] ?? 0, f.up[2] ?? 1);
    u.axisScale.value.set(f.axisScale[0] ?? 1, f.axisScale[1] ?? 1, f.axisScale[2] ?? 1);
    const { sunLighting, dayNight } = this.options;
    if (sunLighting || dayNight > 0) {
      if (this.options.timeMs !== this.sunTimeMs) {
        sunDirectionEcef(this.options.timeMs, this.sunEcef);
        this.sunTimeMs = this.options.timeMs;
      }
      // Normals of the ellipsoid are the sphere's after scaling the Sun by the same axes (ADR 0040).
      u.daySun.value
        .set(
          (this.sunEcef[0] ?? 0) * (f.axisScale[0] ?? 1),
          (this.sunEcef[1] ?? 0) * (f.axisScale[1] ?? 1),
          (this.sunEcef[2] ?? 0) * (f.axisScale[2] ?? 1),
        )
        .normalize();
      // Without sun lighting the sky's Sun turns from behind the eye toward the real one as day and night fade in, so
      // the haze turns with the night instead of jumping when it ends; opposite directions never meet at zero.
      const share = sunLighting ? 1 : dayNight;
      const sun = u.sun.value.copy(u.up.value).lerp(u.daySun.value, share);
      if (sun.lengthSq() < 1e-6) sun.copy(share < 0.5 ? u.up.value : u.daySun.value);
      sun.normalize();
    } else {
      u.sun.value.copy(u.up.value);
      u.daySun.value.copy(u.up.value);
    }
    this.setRays(view);
  }

  /**
   * The world-space ray of a pixel is linear in its normalized device coordinates: (x + P8) / P0 and (y + P9) / P5 in
   * view space at z = −1, rotated into the world by the transposed rotation-only view.
   */
  private setRays(view: FrameView): void {
    const p = view.projection;
    const v = view.view;
    const p0 = p[0] ?? 1;
    const p5 = p[5] ?? 1;
    const u = this.uniforms;
    this.toWorld(v, (p[8] ?? 0) / p0, (p[9] ?? 0) / p5, -1);
    u.rayCenter.value.set(this.scratch[0] ?? 0, this.scratch[1] ?? 0, this.scratch[2] ?? 0);
    this.toWorld(v, 1 / p0, 0, 0);
    u.rayX.value.set(this.scratch[0] ?? 0, this.scratch[1] ?? 0, this.scratch[2] ?? 0);
    this.toWorld(v, 0, 1 / p5, 0);
    u.rayY.value.set(this.scratch[0] ?? 0, this.scratch[1] ?? 0, this.scratch[2] ?? 0);
  }

  /** Rotates a view-space vector into the world: the transpose of the column-major view's rotation. */
  private toWorld(view: Float64Array, x: number, y: number, z: number): void {
    for (let i = 0; i < 3; i++) {
      this.scratch[i] = (view[i * 4] ?? 0) * x + (view[i * 4 + 1] ?? 0) * y + (view[i * 4 + 2] ?? 0) * z;
    }
  }

  /** Frees the sky's geometry and material. */
  dispose(): void {
    this.sky.geometry.dispose();
    (this.sky.material as MeshBasicNodeMaterial).dispose();
  }
}
