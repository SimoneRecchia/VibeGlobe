// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { DepthPath } from '@vibeglobe/core';
import {
  attribute,
  cameraProjectionMatrix,
  cameraViewMatrix,
  float,
  floor,
  length,
  max,
  normalize,
  positionGeometry,
  smoothstep,
  texture,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { DoubleSide, Matrix3, MeshBasicNodeMaterial, Vector3, Vector4, type Node, type Texture } from 'three/webgpu';
import { eyeRelativePosition, morphedEyeRelative, writeFragmentDepth } from './eye-relative.js';

/** How a layer mesh places its vertices (ADR 0037). */
export type LayerShape = 'flat' | 'solid' | 'quad' | 'line';

/**
 * The share of its distance by which a layer vertex is pulled toward the eye: features on the ground draw over the
 * surface they lie on without fighting its depth (2 m at 10 km), and stay hidden behind relief and the globe.
 */
const DEPTH_PULL = 2e-4;
/**
 * Screen-sized quads (points, markers, labels) span pixels around their anchor where the curved surface lies nearer
 * than the anchor: they are pulled further (30 m at 10 km, 60 km at the whole globe's distance), still far less than
 * the globe in front of its far side.
 */
const QUAD_DEPTH_PULL = 3e-3;

/** One endpoint of the morph for a vertex (ADR 0008): its globe offset and its plane offset, eye-relative. */
function endpoint(
  globeOffset: Node<'vec3'>,
  normal: Node<'vec3'>,
  plane: Node<'vec4'>,
  heightMeters: Node<'float'>,
  morphParams: Node<'vec4'>,
  morphAxes: Node<'mat3'>,
  pull: number,
): Node<'vec3'> {
  const sigma = morphParams.z;
  // Heights scale with the relief factor, as the terrain's do (ADR 0034): features keep their height above it.
  const height = heightMeters.mul(morphParams.y);
  const globe = globeOffset.add(normal.mul(height));
  const planeLocal = vec3(plane.x.mul(sigma), plane.y.mul(sigma), height.mul(plane.w).mul(sigma));
  return morphedEyeRelative(globe, morphAxes.mul(planeLocal), morphParams.x).mul(1 - pull);
}

/**
 * The material of one kind of layer mesh (ADR 0037): vertices on the surface's precision and morph path, `flat`
 * geometry as given, `quad` corners offset in screen pixels around their anchor (points, markers, labels), `line`
 * vertices offset across the projected segment by half the width. Colors are straight RGBA, blended over the surface,
 * depth-tested and never written. `setSurfaceMorph` and {@link setLayerViewport} update its uniforms each frame.
 */
export function createLayerMaterial(
  shape: LayerShape,
  depthPath: DepthPath,
  atlas?: Texture,
  labels?: Texture,
): MeshBasicNodeMaterial {
  const morphParams = uniform(new Vector4(0, 1, 1, 0));
  const morphAxes = uniform(new Matrix3());
  // CSS pixels wide and high, and the device pixel ratio.
  const viewport = uniform(new Vector3(1, 1, 1));
  const pixelRatio = viewport.z;
  const normal = attribute('tileNormal', 'vec3');
  const plane = attribute('tilePlane', 'vec4');
  const height = attribute('layerHeight', 'float');
  const color = attribute('layerColor', 'vec4');
  const corner = attribute('layerCorner', 'vec4');
  const pull = shape === 'quad' ? QUAD_DEPTH_PULL : DEPTH_PULL;
  const here = endpoint(positionGeometry, normal, plane, height, morphParams, morphAxes, pull);
  const viewPosition = cameraViewMatrix.mul(vec4(here, 1));
  const clip = cameraProjectionMatrix.mul(viewPosition).toVar();
  let offsetPx: Node<'vec2'> = vec2(corner.x, corner.y);
  if (shape === 'line') {
    const other = endpoint(
      attribute('otherPosition', 'vec3'),
      attribute('otherNormal', 'vec3'),
      attribute('otherPlane', 'vec4'),
      attribute('otherHeight', 'float'),
      morphParams,
      morphAxes,
      pull,
    );
    const otherClip = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(other, 1)));
    const direction = normalize(otherClip.xy.div(otherClip.w).sub(clip.xy.div(clip.w)).mul(viewport.xy));
    // corner.x: the side (±1), corner.y: half the width in pixels.
    offsetPx = vec2(direction.y.negate(), direction.x).mul(corner.x).mul(corner.y);
  }
  const material = new MeshBasicNodeMaterial();
  material.vertexNode =
    shape === 'flat' || shape === 'solid'
      ? clip
      : vec4(clip.xy.add(offsetPx.mul(2).div(viewport.xy).mul(clip.w)), clip.z, clip.w);
  writeFragmentDepth(material, depthPath, viewPosition);
  const { rgb, alpha } = layerColor(shape, color, corner, normal, morphParams, atlas, labels, pixelRatio);
  // Screen-sized quads are not depth-tested: the curved surface around their anchor would cut them (see layerColor).
  if (shape === 'quad') material.depthTest = false;
  material.colorNode = vec4(rgb, alpha);
  // Extruded volumes write depth so their faces occlude each other (F355); flat layers blend without writing it.
  material.transparent = shape !== 'solid';
  material.depthWrite = shape === 'solid';
  material.side = DoubleSide;
  // Flat layers have no back faces to order: one pass, so a batch is one draw call (F352's budget), not two.
  material.forceSinglePass = true;
  material.userData['morphParams'] = morphParams;
  material.userData['morphAxes'] = morphAxes;
  material.userData['viewport'] = viewport;
  return material;
}

/**
 * The color of a layer fragment: straight RGBA, and for quads marker images tinted by it, labels drawn from their
 * distance fields (F358), round points faded at their circle's edge, and anything behind the globe's horizon hidden,
 * where the normal at the anchor faces away from the eye (from m = ½ on nothing is behind a horizon, ADR 0008).
 */
function layerColor(
  shape: LayerShape,
  color: Node<'vec4'>,
  corner: Node<'vec4'>,
  normal: Node<'vec3'>,
  morphParams: Node<'vec4'>,
  atlas: Texture | undefined,
  labels: Texture | undefined,
  pixelRatio: Node<'float'>,
): { rgb: Node<'vec3'>; alpha: Node<'float'> } {
  // A world copy of a ring around a pole (corner.w = 1) shows only on the flat map's half of the morph (F368).
  if (shape !== 'quad')
    return {
      rgb: color.xyz,
      alpha: color.w.mul(corner.w.greaterThan(0.5).and(morphParams.x.lessThan(0.5)).select(0, 1)),
    };
  let rgb: Node<'vec3'> = color.xyz;
  let alpha: Node<'float'> = color.w;
  const uv = attribute('layerUv', 'vec4');
  if (atlas) {
    // Marker images take the color's alpha; solid shapes (u < 0) use the color alone.
    const textured = uv.x.greaterThanEqual(0);
    const sample = texture(atlas, uv.xy.max(vec2(0, 0)));
    rgb = color.xyz.mul(textured.select(sample.xyz, vec3(1, 1, 1)));
    alpha = color.w.mul(textured.select(sample.w, float(1)));
  }
  if (labels) {
    const label = labelColor(labels, uv, color, corner, pixelRatio);
    const isLabel = corner.z.greaterThan(2.5);
    rgb = isLabel.select(label.rgb, rgb);
    alpha = isLabel.select(label.alpha, alpha);
  }
  // corner.zw is the unit square of round points, 2 for every other quad.
  const edge = float(1).sub(smoothstep(0.85, 1, length(vec2(corner.z, corner.w))));
  const facing = normal.dot(eyeRelativePosition(positionGeometry)).lessThan(0).or(morphParams.x.greaterThanEqual(0.5));
  const shown = varying(facing.select(float(1), float(0)));
  return { rgb, alpha: alpha.mul(corner.z.greaterThan(1.5).select(1, edge)).mul(shown) };
}

/** The field value at a label's outline (`sdfFromCoverage`). */
const OUTLINE = 0.72;

/**
 * A label's text from its distance field (F358, ADR 0045): the fill where the field passes the outline and the halo
 * out to its width (`corner.z` − 3, field units), each anti-aliased over about two device pixels (from the field units
 * per CSS pixel, `corner.w`, and the pixel ratio: a screen-space derivative of the 8-bit field is too noisy, and moves
 * text in pixel steps), so the edge stays crisp and moves smoothly at any size and pixel ratio. The fill is the color; the halo's sRGB bytes are packed in `uv.zw` (red × 256 + green,
 * blue × 256 + alpha, `labelShading`).
 */
function labelColor(
  labels: Texture,
  uv: Node<'vec4'>,
  color: Node<'vec4'>,
  corner: Node<'vec4'>,
  pixelRatio: Node<'float'>,
): { rgb: Node<'vec3'>; alpha: Node<'float'> } {
  const d = texture(labels, uv.xy.max(vec2(0, 0))).x;
  const gamma = max(corner.w.div(pixelRatio).mul(0.7), 1e-4);
  const fillA = smoothstep(float(OUTLINE).sub(gamma), float(OUTLINE).add(gamma), d);
  const haloEdge = float(OUTLINE).sub(corner.z.sub(3));
  const haloA = corner.z.greaterThan(3.0001).select(smoothstep(haloEdge.sub(gamma), haloEdge.add(gamma), d), float(0));
  const rg = uv.z.round();
  const ba = uv.w.round();
  const red = floor(rg.div(256));
  const blue = floor(ba.div(256));
  const srgb = vec3(red, rg.sub(red.mul(256)), blue).div(255);
  const haloAlpha = ba.sub(blue.mul(256)).div(255);
  // sRGB to linear light: a cubic fit of the curve, as the vector-tile text material does.
  const halo = srgb.mul(srgb.mul(srgb.mul(0.305306011).add(0.682171111)).add(0.012522878));
  const fa = fillA.mul(color.w);
  const ha = haloA.mul(haloAlpha).mul(float(1).sub(fa));
  const alpha = fa.add(ha);
  return { rgb: color.xyz.mul(fa).add(halo.mul(ha)).div(max(alpha, 1e-4)), alpha };
}

/**
 * Sets the CSS-pixel viewport a layer material offsets its screen-sized parts in, and its device pixel ratio, from the
 * frame's view: the view itself is passed, as a double argument to a call V8 does not inline is boxed (F064).
 */
export function setLayerViewport(
  material: MeshBasicNodeMaterial,
  view: { readonly widthPx: number; readonly heightPx: number; readonly pixelRatio: number },
): void {
  (material.userData['viewport'] as { value: Vector3 } | undefined)?.value.set(
    view.widthPx,
    view.heightPx,
    view.pixelRatio,
  );
}
