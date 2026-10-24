/**
 * Materials of vector tile meshes (ADR 0131): fills, lines extruded across their screen direction with dashes,
 * building extrusions with flat-shaded walls, and circles. Every vertex follows the surface's precision and morph path
 * (ADR 0004, ADR 0008), with ground heights draped on the terrain and scaled by its relief, and heights above the
 * ground scaled on the flat map by the Mercator scale factor (F458). Paint values (sRGB colors) come per vertex at the two integer
 * zooms around the camera's (A and B) and are mixed by the layer's zoom factor, so they change continuously (F440).
 * Each draw keeps only the fragments inside its target tile's square (`clip`), so neighboring tiles and stand-in
 * ancestors cover every point exactly once (F440, F442).
 */
import type { DepthPath } from '@vibeglobe/core';
import {
  attribute,
  cameraNear,
  cameraProjectionMatrix,
  cameraViewMatrix,
  float,
  length,
  max,
  min,
  mod,
  normalize,
  positionGeometry,
  smoothstep,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import {
  DoubleSide,
  GreaterEqualDepth,
  Matrix3,
  MeshBasicNodeMaterial,
  Vector2,
  Vector4,
  type Node,
  type Object3D,
} from 'three/webgpu';
import { morphedEyeRelative } from '../eye-relative.js';

/** What a vector tile mesh draws. */
export type VectorMeshKind = 'fill' | 'line' | 'extrusion' | 'circle';

/** Per-draw values, kept in `object.userData.vectorDraw` and read per object by the materials. */
export interface VectorDrawUniforms {
  /** The target square in the tile's units: minX, minY, maxX, maxY. */
  readonly clip: Vector4;
  /** CSS pixels per tile unit at the current zoom, then 0, 0, 0. */
  readonly tile: Vector4;
}

/**
 * Share of its distance by which a draped vertex is pulled toward the eye (ADR 0037's method): 30 m at 10 km. Less
 * left seams where the surface's tile edges come nearer than the fills, at grazing views (0.2% was the least that
 * closed them on the fixture views; 0.3% keeps a margin).
 */
const DEPTH_PULL = 3e-3;
/** Pull of circles, which span pixels around their anchor where the curved surface may lie nearer. */
const CIRCLE_DEPTH_PULL = 3e-3;

function drawOf(object: Object3D | null | undefined): VectorDrawUniforms | undefined {
  return object?.userData['vectorDraw'] as VectorDrawUniforms | undefined;
}

interface Uniforms {
  readonly morphParams: Node<'vec4'>;
  readonly morphAxes: Node<'mat3'>;
  readonly viewport: Node<'vec2'>;
  /** Layer opacity times its fade, the zoom factor between A and B, the height scale of extrusions, then 0. */
  readonly layer: Node<'vec4'>;
  /** Dash and gap lengths in line widths (up to two pairs); `dashInfo`: pattern length, 1 when dashed. */
  readonly dash: Node<'vec4'>;
  readonly dashInfo: Node<'vec4'>;
  readonly clip: Node<'vec4'>;
  readonly tile: Node<'vec4'>;
}

function createUniforms(): Uniforms {
  return {
    morphParams: uniform(new Vector4(0, 1, 1, 0)),
    morphAxes: uniform(new Matrix3()),
    viewport: uniform(new Vector2(1, 1)),
    layer: uniform(new Vector4(1, 0, 0, 0)),
    dash: uniform(new Vector4(0, 0, 0, 0)),
    dashInfo: uniform(new Vector4(0, 0, 0, 0)),
    clip: uniform(new Vector4(-1e9, -1e9, 1e9, 1e9)).onObjectUpdate(({ object }) => drawOf(object)?.clip),
    tile: uniform(new Vector4(1, 0, 0, 0)).onObjectUpdate(({ object }) => drawOf(object)?.tile),
  } as unknown as Uniforms;
}

/**
 * One morph endpoint pair of a vertex, eye-relative: the globe endpoint from its offset, normal and heights, the plane
 * endpoint from its Mercator offsets. Ground heights scale with the relief factor (as the terrain does); heights above
 * the ground (buildings) do not, and scale by k(φ) on the plane (F458).
 */
function placed(
  offset: Node<'vec3'>,
  normal: Node<'vec3'>,
  plane: Node<'vec4'>,
  ground: Node<'float'>,
  above: Node<'float'>,
  u: Uniforms,
  pull: number,
): Node<'vec3'> {
  const sigma = u.morphParams.z;
  const height = ground.mul(u.morphParams.y).add(above);
  const globe = offset.add(normal.mul(height));
  const planeLocal = vec3(plane.x.mul(sigma), plane.y.mul(sigma), height.mul(plane.w).mul(sigma));
  return morphedEyeRelative(globe, u.morphAxes.mul(planeLocal), u.morphParams.x).mul(1 - pull);
}

function mixAB(name: 'vtColor' | 'vtParams', u: Uniforms): Node<'vec4'> {
  const a = attribute(`${name}A`, 'vec4');
  const b = attribute(`${name}B`, 'vec4');
  return a.add(b.sub(a).mul(u.layer.y));
}

/**
 * Straight sRGB RGBA to linear light (the output is encoded back to sRGB): paint is mixed in sRGB, as the style
 * specification interpolates colors, and converted after mixing.
 */
function linearRgba(srgb: Node<'vec4'>): Node<'vec4'> {
  // A cubic fit of the sRGB curve (within 0.5% of it; exact at 0 and 1), without a branch.
  const c = srgb.xyz;
  return vec4(c.mul(c.mul(c.mul(0.305306011).add(0.682171111)).add(0.012522878)), srgb.w);
}

/** 1 inside the draw's target square, else 0, from the vertex's interpolated tile position. */
function insideClip(u: Uniforms): Node<'float'> {
  const p = varying(attribute('vtTile', 'vec2'));
  const inside = p.x
    .greaterThanEqual(u.clip.x)
    .and(p.x.lessThan(u.clip.z))
    .and(p.y.greaterThanEqual(u.clip.y))
    .and(p.y.lessThan(u.clip.w));
  return inside.select(float(1), float(0));
}

function finish(
  material: MeshBasicNodeMaterial,
  viewPosition: Node<'vec4'>,
  depthPath: DepthPath,
  solid: boolean,
): MeshBasicNodeMaterial {
  if (depthPath === 'fragment') {
    material.depthNode = cameraNear.div(varying(viewPosition.z.negate()));
    material.depthFunc = GreaterEqualDepth;
  }
  material.transparent = !solid;
  material.depthWrite = solid;
  material.side = DoubleSide;
  material.forceSinglePass = true;
  return material;
}

function ground(): Node<'float'> {
  return attribute('vtGround', 'float');
}

function fillMaterial(u: Uniforms, depthPath: DepthPath): MeshBasicNodeMaterial {
  const here = placed(
    positionGeometry,
    attribute('tileNormal', 'vec3'),
    attribute('tilePlane', 'vec4'),
    ground(),
    float(0),
    u,
    DEPTH_PULL,
  );
  const viewPosition = cameraViewMatrix.mul(vec4(here, 1));
  const material = new MeshBasicNodeMaterial();
  material.vertexNode = cameraProjectionMatrix.mul(viewPosition);
  const color = linearRgba(varying(mixAB('vtColor', u)));
  material.colorNode = vec4(color.xyz, color.w.mul(u.layer.x).mul(insideClip(u)));
  return finish(material, viewPosition, depthPath, false);
}

function lineMaterial(u: Uniforms, depthPath: DepthPath): MeshBasicNodeMaterial {
  const normal = attribute('tileNormal', 'vec3');
  const here = placed(positionGeometry, normal, attribute('tilePlane', 'vec4'), ground(), float(0), u, DEPTH_PULL);
  const side = placed(
    attribute('vtSidePosition', 'vec3'),
    attribute('vtSideNormal', 'vec3'),
    attribute('vtSidePlane', 'vec4'),
    ground(),
    float(0),
    u,
    DEPTH_PULL,
  );
  const viewPosition = cameraViewMatrix.mul(vec4(here, 1));
  const clip = cameraProjectionMatrix.mul(viewPosition).toVar();
  const sideClip = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(side, 1)));
  const screen = sideClip.xy.div(sideClip.w).sub(clip.xy.div(clip.w)).mul(u.viewport);
  const direction = screen.div(max(length(screen), 1e-6));
  const line = attribute('vtLine', 'vec4');
  const extrusion = vec2(line.x, line.y);
  // params: half width in CSS pixels, blur, gap half width, offset (offset is not drawn yet).
  const params = mixAB('vtParams', u);
  const halfWidth = max(params.x.add(params.z), 0.5);
  const offsetPx = direction.mul(length(extrusion)).mul(halfWidth);
  const material = new MeshBasicNodeMaterial();
  material.vertexNode = vec4(clip.xy.add(offsetPx.mul(2).div(u.viewport).mul(clip.w)), clip.z, clip.w);
  // Across the line: 0 on the center line, 1 at the edge (miter tips clamp to 1).
  const across = varying(extrusion.div(max(length(extrusion), 1)));
  const halfWidthV = varying(halfWidth);
  const fromEdgePx = float(1).sub(length(across)).mul(halfWidthV);
  const blur = varying(params.y);
  let alpha: Node<'float'> = smoothstep(float(-0.5), max(blur, 0.5), fromEdgePx);
  // A gap width draws two lines (casing): the inner gap is left open.
  const gap = varying(params.z);
  alpha = alpha.mul(
    smoothstep(gap.sub(0.5), gap.add(0.5), length(across).mul(halfWidthV)).max(
      gap.lessThan(0.01).select(float(1), float(0)),
    ),
  );
  alpha = alpha.mul(dashMask(u, varying(line.z), halfWidthV));
  const color = linearRgba(varying(mixAB('vtColor', u)));
  material.colorNode = vec4(color.xyz, color.w.mul(alpha).mul(u.layer.x).mul(insideClip(u)));
  return finish(material, viewPosition, depthPath, false);
}

/** 1 on dashes, 0 in gaps: the distance along the line in pixels against the pattern in line widths. */
function dashMask(u: Uniforms, distanceUnits: Node<'float'>, halfWidth: Node<'float'>): Node<'float'> {
  const width = halfWidth.mul(2);
  const t = mod(distanceUnits.mul(u.tile.x).div(width), max(u.dashInfo.x, 1e-3));
  const d0 = u.dash.x;
  const g0 = d0.add(u.dash.y);
  const d1 = g0.add(u.dash.z);
  const on = t.lessThan(d0).or(t.greaterThanEqual(g0).and(t.lessThan(d1)));
  return u.dashInfo.y.lessThan(0.5).or(on).select(float(1), float(0));
}

function extrusionMaterial(u: Uniforms, depthPath: DepthPath, solid: boolean): MeshBasicNodeMaterial {
  // Buildings grow from the ground as their layer fades in (F457): the layer's height scale.
  const above = attribute('vtHeight', 'float').mul(u.layer.z);
  const here = placed(
    positionGeometry,
    attribute('tileNormal', 'vec3'),
    attribute('tilePlane', 'vec4'),
    ground(),
    above,
    u,
    0,
  );
  const viewPosition = cameraViewMatrix.mul(vec4(here, 1));
  const material = new MeshBasicNodeMaterial();
  material.vertexNode = cameraProjectionMatrix.mul(viewPosition);
  // Flat shading from the map-anchored light of the style specification (azimuth 210°, polar 30°, intensity 0.5);
  // tile frame: x east, y south, z up.
  const n = normalize(attribute('vtShadeNormal', 'vec3'));
  const light = normalize(vec3(-0.25, 0.433, 0.866));
  const lambert = max(n.dot(light), 0);
  const shade = float(0.5).add(lambert.mul(0.5));
  // Vertical gradient: walls darken toward their base (`fill-extrusion-vertical-gradient`); roofs, at the top, get 1.
  // (A `select` on a boolean inside this varying made roofs vanish on WebGL2, so none is used.)
  const gradient = min(float(1), float(0.7).add(above.div(max(attribute('vtTop', 'float'), 1)).mul(0.3)));
  const color = linearRgba(varying(mixAB('vtColor', u)));
  const lit = color.xyz.mul(varying(shade.mul(gradient)));
  const alpha = color.w.mul(u.layer.x).mul(insideClip(u));
  // Solid extrusions blend nothing: their alpha only carries the clip, which the alpha test discards.
  material.colorNode = vec4(lit, solid ? insideClip(u) : alpha);
  if (solid) material.alphaTestNode = float(0.5);
  return finish(material, viewPosition, depthPath, solid);
}

function circleMaterial(u: Uniforms, depthPath: DepthPath): MeshBasicNodeMaterial {
  const here = placed(
    positionGeometry,
    attribute('tileNormal', 'vec3'),
    attribute('tilePlane', 'vec4'),
    ground(),
    float(0),
    u,
    CIRCLE_DEPTH_PULL,
  );
  const viewPosition = cameraViewMatrix.mul(vec4(here, 1));
  const clip = cameraProjectionMatrix.mul(viewPosition).toVar();
  const corner = attribute('vtCorner', 'vec2');
  // params: radius, blur, stroke width, 0 (CSS pixels); colors: fill (vtColor) and stroke (vtStroke).
  const params = mixAB('vtParams', u);
  const outer = params.x.add(params.z);
  const material = new MeshBasicNodeMaterial();
  material.vertexNode = vec4(clip.xy.add(corner.mul(outer.add(1)).mul(2).div(u.viewport).mul(clip.w)), clip.z, clip.w);
  const r = length(varying(corner)).mul(varying(outer.add(1)));
  const edge = float(1).sub(smoothstep(varying(outer).sub(0.5), varying(outer).add(0.5), r));
  const strokeT = smoothstep(varying(params.x).sub(0.5), varying(params.x).add(0.5), r);
  const fill = linearRgba(varying(mixAB('vtColor', u)));
  const stroke = linearRgba(varying(attribute('vtStroke', 'vec4')));
  const rgb = fill.xyz.add(stroke.xyz.sub(fill.xyz).mul(strokeT));
  const a = fill.w.add(stroke.w.sub(fill.w).mul(strokeT));
  material.colorNode = vec4(rgb, a.mul(edge).mul(u.layer.x).mul(insideClip(u)));
  material.depthTest = false;
  return finish(material, viewPosition, depthPath, false);
}

/**
 * A material for one kind of vector mesh; its uniforms are in `userData.vectorUniforms`, set each frame with
 * {@link setVectorFrame} and {@link setVectorLayer}. Solid extrusions write depth; everything else blends without.
 */
export function createVectorMaterial(
  kind: VectorMeshKind,
  depthPath: DepthPath,
  options: { readonly solid?: boolean } = {},
): MeshBasicNodeMaterial {
  const u = createUniforms();
  const material =
    kind === 'fill'
      ? fillMaterial(u, depthPath)
      : kind === 'line'
        ? lineMaterial(u, depthPath)
        : kind === 'extrusion'
          ? extrusionMaterial(u, depthPath, options.solid ?? true)
          : circleMaterial(u, depthPath);
  material.userData['vectorUniforms'] = u;
  return material;
}

function uniformsOf(material: MeshBasicNodeMaterial): Uniforms | undefined {
  return material.userData['vectorUniforms'] as Uniforms | undefined;
}

type Valued<T> = { value: T };

/** Sets a material's per-frame uniforms: the morph (ADR 0008) and the CSS-pixel viewport. */
export function setVectorFrame(
  material: MeshBasicNodeMaterial,
  morph: { readonly morph: number; readonly relief: number; readonly sigma: number; readonly axes: ArrayLike<number> },
  widthPx: number,
  heightPx: number,
): void {
  const u = uniformsOf(material);
  if (u === undefined) return;
  (u.morphParams as unknown as Valued<Vector4>).value.set(morph.morph, morph.relief, morph.sigma, 0);
  (u.morphAxes as unknown as Valued<Matrix3>).value.fromArray(morph.axes as number[]);
  (u.viewport as unknown as Valued<Vector2>).value.set(widthPx, heightPx);
}

/** Sets a material's layer uniforms: opacity (with its fade), the zoom factor between A and B, and the dash pattern. */
export function setVectorLayer(
  material: MeshBasicNodeMaterial,
  opacity: number,
  zoomT: number,
  dashWidths?: readonly number[],
  heightScale = 1,
): void {
  const u = uniformsOf(material);
  if (u === undefined) return;
  (u.layer as unknown as Valued<Vector4>).value.set(opacity, zoomT, heightScale, 0);
  const dash = (u.dash as unknown as Valued<Vector4>).value;
  const info = (u.dashInfo as unknown as Valued<Vector4>).value;
  if (dashWidths === undefined || dashWidths.length < 2) {
    info.set(0, 0, 0, 0);
    return;
  }
  const d = [0, 1, 2, 3].map((i) => Math.max(0, dashWidths[i] ?? 0));
  dash.set(d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, d[3] ?? 0);
  info.set(
    d.reduce((a, b) => a + b, 0),
    1,
    0,
    0,
  );
}
