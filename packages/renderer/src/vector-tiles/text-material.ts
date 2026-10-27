// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The text material of labels (F448, F449, ADR 0132), exported for data-layer labels too (F358): screen-space quads
 * whose corners are given in CSS pixels (placement and collision run on the CPU), shaded from an {@link SdfAtlas}.
 * Glyphs are signed distance fields drawn crisp at any size and pixel density, with a halo; icons are RGBA images
 * (premultiplied sRGB in the atlas).
 * Labels are drawn over the scene without depth testing: placement already hid those behind the globe.
 *
 * Attributes per vertex: `labelScreen` (x, y CSS pixels from the top left), `labelUv` (atlas texels), `labelFill` and
 * `labelHalo` (straight linear RGBA; an icon's opacity in the fill's alpha), `labelParams` (glyph scale = text size / 24, halo width in CSS pixels, opacity,
 * 1 for an icon).
 */
import { attribute, float, max, smoothstep, texture, uniform, varying, vec2, vec4 } from 'three/tsl';
import { DoubleSide, MeshBasicNodeMaterial, Vector2, type Node, type Texture } from 'three/webgpu';

/** The SDF value at a glyph's outline (glyph PBF format). */
const OUTLINE = 0.75;
/** SDF units per glyph texel at 24 px (a radius of 8 texels). */
const SDF_PER_TEXEL = 1 / 8;

/**
 * A label material over `atlas` (an {@link SdfAtlas} texture of `atlasSize` texels). Call {@link setTextViewport}
 * each frame.
 */
export function createTextMaterial(atlas: Texture, atlasSize: number): MeshBasicNodeMaterial {
  const viewport = uniform(new Vector2(1, 1));
  const screen = attribute('labelScreen', 'vec2');
  const params = attribute('labelParams', 'vec4');
  const ndc = vec2(screen.x.div(viewport.x).mul(2).sub(1), float(1).sub(screen.y.div(viewport.y).mul(2)));
  const material = new MeshBasicNodeMaterial();
  // Nearer than any scene depth on both depth paths, in case a backend keeps the depth test.
  material.vertexNode = vec4(ndc, 0.5, 1);
  const uv = varying(attribute('labelUv', 'vec2').div(atlasSize));
  const sample = texture(atlas, uv);
  const p = varying(params);
  // One CSS pixel spans this many SDF units; the edge is anti-aliased over about one pixel.
  const perPx = float(SDF_PER_TEXEL).div(max(p.x, 1e-3));
  const gamma = perPx.mul(0.7);
  const d = sample.x;
  const fillA = smoothstep(float(OUTLINE).sub(gamma), float(OUTLINE).add(gamma), d);
  const haloEdge = float(OUTLINE).sub(p.y.mul(perPx));
  const haloA = p.y.greaterThan(0).select(smoothstep(haloEdge.sub(gamma), haloEdge.add(gamma), d), float(0));
  const fill = varying(attribute('labelFill', 'vec4'));
  const halo = varying(attribute('labelHalo', 'vec4'));
  const fa = fillA.mul(fill.w);
  const ha = haloA.mul(halo.w).mul(float(1).sub(fa));
  const alpha = fa.add(ha);
  const rgb = fill.xyz.mul(fa).add(halo.xyz.mul(ha)).div(max(alpha, 1e-4));
  const icon = p.w.greaterThan(0.5);
  // Icons are premultiplied sRGB: straight color, then linear light (a cubic fit of the sRGB curve).
  const s = sample.xyz.div(max(sample.w, 1e-4));
  const linear = s.mul(s.mul(s.mul(0.305306011).add(0.682171111)).add(0.012522878));
  const iconColor = vec4(linear, sample.w.mul(p.z).mul(fill.w));
  material.colorNode = icon.select(iconColor, vec4(rgb, alpha.mul(p.z))) as Node<'vec4'>;
  material.transparent = true;
  material.depthTest = false;
  material.depthWrite = false;
  // Corners run clockwise on screen: both faces are drawn.
  material.side = DoubleSide;
  material.forceSinglePass = true;
  material.userData['viewport'] = viewport;
  return material;
}

/** Sets the CSS-pixel viewport the text material maps its corners from. */
export function setTextViewport(material: MeshBasicNodeMaterial, widthPx: number, heightPx: number): void {
  (material.userData['viewport'] as { value: Vector2 } | undefined)?.value.set(widthPx, heightPx);
}
