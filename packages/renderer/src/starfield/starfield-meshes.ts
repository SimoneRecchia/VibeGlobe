// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
// The space background's meshes (ADR 0181): one sprite of four vertices per catalog star, sized and lit in the vertex
// stage by `starSprite`'s rule, and a full-screen backdrop that draws the Milky Way procedurally in galactic
// coordinates. Both sit at the far end of the depth range like the atmosphere's sky and draw only where no surface
// wrote depth. Both add their light to what is behind them (one-one blending); the backdrop also adds the background's
// opacity to the alpha channel, so over a transparent canvas space is black where it shows, and over the atmosphere's
// opaque sky the light simply adds. Loaded on demand: nothing touches three.js at import time.
import type { DepthPath } from '@vibeglobe/core';
import {
  Fn,
  If,
  abs,
  asin,
  atan,
  attribute,
  clamp,
  dot,
  exp,
  float,
  floor,
  fract,
  hash,
  log,
  max,
  min,
  mix,
  normalize,
  positionGeometry,
  pow,
  select,
  smoothstep,
  sqrt,
  uniform,
  varying,
  vec3,
  vec4,
} from 'three/tsl';
import {
  AddEquation,
  BufferAttribute,
  BufferGeometry,
  CustomBlending,
  GreaterEqualDepth,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  OneFactor,
  Vector2,
  Vector3,
  type Node,
} from 'three/webgpu';
import { MIN_SIGMA_DEVICE_PX, type StarCatalog } from './star-catalog.js';

type FloatNode = Node<'float'>;
type Vec3Node = Node<'vec3'>;

/** The per-frame values of both meshes, set by the extension (allocation-free). */
export interface StarfieldUniforms {
  /** Celestial direction (w = 0) to clip space (`celestialToClip`). */
  readonly celestialToClip: { value: Matrix4 };
  /** The drawing buffer's size, device pixels. */
  readonly bufferPx: { value: Vector2 };
  readonly pixelRatio: { value: number };
  /** The stars' brightness multiplier. */
  readonly brightness: { value: number };
  /** The background's opacity this frame (`skyVisibility`). */
  readonly visibility: { value: number };
  /** The Milky Way's brightness: 1 drawn, 0 off (the backdrop's opacity stays). */
  readonly milkyWay: { value: number };
  /** The sky ray through the view's center and its change per unit of NDC x and y, galactic axes. */
  readonly rayCenter: { value: Vector3 };
  readonly rayX: { value: Vector3 };
  readonly rayY: { value: Vector3 };
}

/** Both meshes and their uniforms. */
export interface StarfieldMeshes {
  readonly uniforms: StarfieldUniforms;
  readonly stars: Mesh;
  readonly milkyWay: Mesh;
  dispose(): void;
}

/** Drawn first among transparent objects: the background is behind everything. */
const RENDER_ORDER = -1_000_000;
/** The Milky Way's brightness at its brightest, linear. */
const MILKY_WAY_INTENSITY = 0.045;

function n<T extends 'float' | 'vec2' | 'vec3' | 'mat4'>(value: unknown): Node<T> {
  return value as Node<T>;
}

/**
 * One-one blending of color and alpha, at the far end of the depth range, never writing depth (ADR 0005: 0 is the far
 * end on every path). The fragment's color is premultiplied light; its alpha, the opacity it adds.
 */
function backgroundMaterial(depthPath: DepthPath): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial();
  material.transparent = true;
  material.blending = CustomBlending;
  material.blendEquation = AddEquation;
  material.blendSrc = OneFactor;
  material.blendDst = OneFactor;
  material.blendEquationAlpha = AddEquation;
  material.blendSrcAlpha = OneFactor;
  material.blendDstAlpha = OneFactor;
  material.depthWrite = false;
  if (depthPath === 'fragment') {
    material.depthNode = float(0);
    material.depthFunc = GreaterEqualDepth;
  }
  return material;
}

function starGeometry(catalog: StarCatalog): BufferGeometry {
  const count = catalog.count;
  const directions = new Float32Array(count * 12);
  const corners = new Float32Array(count * 8);
  const magnitudes = new Float32Array(count * 4);
  const colors = new Float32Array(count * 12);
  const index = new Uint32Array(count * 6);
  const CORNERS = [-1, -1, 1, -1, 1, 1, -1, 1];
  for (let s = 0; s < count; s++) {
    for (let v = 0; v < 4; v++) {
      const at = s * 4 + v;
      for (let c = 0; c < 3; c++) {
        directions[at * 3 + c] = catalog.directions[s * 3 + c] ?? 0;
        colors[at * 3 + c] = catalog.colors[s * 3 + c] ?? 1;
      }
      corners[at * 2] = CORNERS[v * 2] ?? 0;
      corners[at * 2 + 1] = CORNERS[v * 2 + 1] ?? 0;
      magnitudes[at] = catalog.magnitudes[s] ?? 0;
    }
    index.set([s * 4, s * 4 + 1, s * 4 + 2, s * 4, s * 4 + 2, s * 4 + 3], s * 6);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(directions, 3));
  geometry.setAttribute('corner', new BufferAttribute(corners, 2));
  geometry.setAttribute('magnitude', new BufferAttribute(magnitudes, 1));
  geometry.setAttribute('starColor', new BufferAttribute(colors, 3));
  geometry.setIndex(new BufferAttribute(index, 1));
  return geometry;
}

/** The star sprites: `starSprite` in the vertex stage, a Gaussian in the fragment stage. */
function starMaterial(u: StarfieldUniforms, depthPath: DepthPath): MeshBasicNodeMaterial {
  const material = backgroundMaterial(depthPath);
  const corner = attribute('corner', 'vec2');
  const magnitude = attribute('magnitude', 'float');
  const pixelRatio = n<'float'>(u.pixelRatio);
  const clip = n<'mat4'>(u.celestialToClip).mul(vec4(positionGeometry, 0));
  const sigmaCss = float(0.5).add(max(float(3).sub(magnitude), 0).mul(0.12));
  const sigmaDevice = max(float(MIN_SIGMA_DEVICE_PX), sigmaCss.mul(pixelRatio));
  const light = n<'float'>(u.brightness)
    .mul(0.25)
    .mul(pow(float(10), magnitude.sub(6.5).mul(-0.24)));
  const sigmaShown = sigmaDevice.div(pixelRatio);
  const peak = min(float(1), light.div(sigmaShown.mul(sigmaShown).mul(2 * Math.PI)));
  const shownPeak = peak.mul(n<'float'>(u.visibility));
  // The quad reaches where the Gaussian falls under 1/512 of full light (at most three radii, which hold all but
  // 0.01 % of it): faint stars, most of the catalog, cover fewer pixels.
  const radii = clamp(sqrt(log(max(shownPeak.mul(512), 1.01)).mul(2)), 1, 3);
  const offset = corner.mul(sigmaDevice.mul(radii).mul(2)).div(n<'vec2'>(u.bufferPx));
  const shown = clip.w.greaterThan(0).and(shownPeak.greaterThan(1 / 1024));
  material.vertexNode = select(shown, vec4(clip.xy.add(offset.mul(clip.w)), 0, clip.w), vec4(2, 2, 0, 1));
  const local = varying(corner.mul(radii));
  const alpha = varying(peak)
    .mul(exp(dot(local, local).mul(-0.5)))
    .mul(n<'float'>(u.visibility));
  material.colorNode = vec4(varying(attribute('starColor', 'vec3')).mul(alpha), 0);
  return material;
}

/** Smooth value noise on a 3D point, 0–1. */
const valueNoise = Fn(([point]: [Vec3Node]) => {
  // Offset so lattice indices stay positive for the integer hash; the seeds stay under 2²⁴, exact in float32, so
  // every backend hashes the same lattice (noise frequencies are at most 15, indices within ±16).
  const cell = floor(point).add(64);
  const f = fract(point);
  const w = f.mul(f).mul(vec3(3).sub(f.mul(2)));
  const corner = (x: number, y: number, z: number): FloatNode =>
    hash(dot(cell.add(vec3(x, y, z)), vec3(1, 131, 17_161)));
  const x00 = mix(corner(0, 0, 0), corner(1, 0, 0), w.x);
  const x10 = mix(corner(0, 1, 0), corner(1, 1, 0), w.x);
  const x01 = mix(corner(0, 0, 1), corner(1, 0, 1), w.x);
  const x11 = mix(corner(0, 1, 1), corner(1, 1, 1), w.x);
  return mix(mix(x00, x10, w.y), mix(x01, x11, w.y), w.z);
});

/**
 * The Milky Way's light along a galactic direction: a disk widening and brightening toward the galactic center, its
 * bulge, the dark dust lane along the inner plane, and clumps of a few degrees from value noise (no feature smaller
 * than several pixels at any field of view, so nothing shimmers).
 */
const milkyWayColor = Fn(([direction]: [Vec3Node]) => {
  const color = vec3(0).toVar();
  const b = asin(clamp(direction.z, -1, 1));
  // Beyond 0.6 rad (34°) of the plane the disk and the bulge are under 10⁻⁷: the noise is not evaluated there.
  If(abs(b).lessThan(0.6), () => {
    const l = atan(direction.y, direction.x);
    const inner = l.cos().mul(0.5).add(0.5);
    const width = float(0.08).add(inner.mul(0.07));
    const disk = exp(b.div(width).pow(2).negate()).mul(inner.mul(inner).mul(0.65).add(0.35));
    const bulge = exp(l.mul(l).div(0.09).add(b.mul(b).div(0.04)).negate());
    const middle = valueNoise(direction.mul(7));
    const clumps = valueNoise(direction.mul(3))
      .mul(0.5)
      .add(middle.mul(0.3))
      .add(valueNoise(direction.mul(15)).mul(0.2));
    const lane = exp(b.sub(0.005).div(0.025).pow(2).negate())
      .mul(smoothstep(1.4, 0.3, abs(l)))
      .mul(middle.add(0.5));
    const dust = float(1).sub(min(float(0.85), lane.mul(0.65)));
    const value = disk.add(bulge.mul(0.9)).mul(dust).mul(clumps.mul(0.9).add(0.55));
    const tint = mix(vec3(0.78, 0.84, 1), vec3(1, 0.88, 0.7), clamp(bulge.add(inner.mul(0.3)), 0, 1));
    color.assign(tint.mul(value.mul(MILKY_WAY_INTENSITY)));
  });
  return color;
});

function milkyWayMaterial(u: StarfieldUniforms, depthPath: DepthPath): MeshBasicNodeMaterial {
  const material = backgroundMaterial(depthPath);
  const ndc = positionGeometry.xy;
  const ray = varying(n<'vec3'>(u.rayCenter).add(n<'vec3'>(u.rayX).mul(ndc.x)).add(n<'vec3'>(u.rayY).mul(ndc.y)));
  material.vertexNode = vec4(ndc, 0, 1);
  const visibility = n<'float'>(u.visibility);
  material.colorNode = vec4(milkyWayColor(normalize(ray)).mul(visibility.mul(n<'float'>(u.milkyWay))), visibility);
  return material;
}

function placeOnce(mesh: Mesh, name: string): Mesh {
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.matrixWorldAutoUpdate = false;
  mesh.renderOrder = RENDER_ORDER;
  mesh.name = name;
  return mesh;
}

/** Builds the star sprites of a catalog and the Milky Way for a depth path. */
export function createStarfieldMeshes(catalog: StarCatalog, depthPath: DepthPath): StarfieldMeshes {
  const uniforms = {
    celestialToClip: uniform(new Matrix4()),
    bufferPx: uniform(new Vector2(1, 1)),
    pixelRatio: uniform(1),
    brightness: uniform(1),
    visibility: uniform(1),
    milkyWay: uniform(1),
    rayCenter: uniform(new Vector3(0, 0, -1)),
    rayX: uniform(new Vector3(1, 0, 0)),
    rayY: uniform(new Vector3(0, 1, 0)),
  } as unknown as StarfieldUniforms;
  const stars = placeOnce(new Mesh(starGeometry(catalog), starMaterial(uniforms, depthPath)), 'starfield-stars');
  const triangle = new BufferGeometry();
  triangle.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const milkyWay = placeOnce(new Mesh(triangle, milkyWayMaterial(uniforms, depthPath)), 'starfield-milky-way');
  // The Milky Way first, the stars over it.
  milkyWay.renderOrder = RENDER_ORDER - 1;
  return {
    uniforms,
    stars,
    milkyWay,
    dispose() {
      for (const mesh of [stars, milkyWay]) {
        mesh.removeFromParent();
        mesh.geometry.dispose();
        (mesh.material as MeshBasicNodeMaterial).dispose();
      }
    },
  };
}
