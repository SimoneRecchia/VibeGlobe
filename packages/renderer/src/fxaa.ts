// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The scene drawn into a texture without multisampling (KB-140), shown as it is, or through fast approximate
 * anti-aliasing: each pixel blended along the edge through it, found from the luminance of its four diagonal
 * neighbors. Loaded with the first frame that uses it.
 */
import { abs, clamp, dot, float, Fn, max, min, pass, screenSize, screenUV, select, vec2, vec3, vec4 } from 'three/tsl';
import { DepthTexture, FloatType, RenderPipeline, type Camera, type Scene, type WebGPURenderer } from 'three/webgpu';

/** Rec. 709 luminance weights. */
const LUMA = vec3(0.2126, 0.7152, 0.0722);
/** The smallest edge strength, and its share of the local luminance, that keeps the blend direction stable. */
const REDUCE_MIN = 1 / 128;
const REDUCE_SHARE = 1 / 8;
/** The longest blend, in pixels. */
const SPAN_PX = 8;

/** A frame drawn through the pass. */
export interface SinglePass {
  render(): void;
  dispose(): void;
}

/** The pass over `scene` seen from `camera`, drawn by `renderer`, with FXAA or without. */
export function createSinglePass(renderer: WebGPURenderer, scene: Scene, camera: Camera, fxaa: boolean): SinglePass {
  // Without multisampling whatever the canvas has: `none` shows these pixels as they are. Float depth, as the
  // renderer's own scene target has (`useFloatSceneDepth`): 24 bits cannot hold near / d over a globe (ADR 0005).
  const scenePass = pass(scene, camera, { samples: 0, depthTexture: new DepthTexture(1, 1, FloatType) });
  const frame = scenePass.getTextureNode();
  const output = Fn(() => {
    const texel = vec2(1).div(screenSize);
    const at = (dx: number, dy: number) => frame.sample(screenUV.add(vec2(dx, dy).mul(texel)));
    const center = at(0, 0);
    const nw = dot(at(-1, -1).rgb, LUMA);
    const ne = dot(at(1, -1).rgb, LUMA);
    const sw = dot(at(-1, 1).rgb, LUMA);
    const se = dot(at(1, 1).rgb, LUMA);
    const m = dot(center.rgb, LUMA);
    const lowest = min(m, min(min(nw, ne), min(sw, se)));
    const highest = max(m, max(max(nw, ne), max(sw, se)));
    // Across the edge: the direction in which the luminance changes most; the blend runs perpendicular to it.
    const across = vec2(sw.add(se).sub(nw.add(ne)), nw.add(sw).sub(ne.add(se)));
    const reduce = max(
      nw
        .add(ne)
        .add(sw)
        .add(se)
        .mul(0.25 * REDUCE_SHARE),
      float(REDUCE_MIN),
    );
    const scale = float(1).div(min(abs(across.x), abs(across.y)).add(reduce));
    const step = clamp(across.mul(scale), vec2(-SPAN_PX), vec2(SPAN_PX)).mul(texel);
    const sample = (t: number) => frame.sample(screenUV.add(step.mul(t))).rgb;
    const inner = sample(-1 / 6)
      .add(sample(1 / 6))
      .mul(0.5);
    const outer = inner.mul(0.5).add(sample(-0.5).add(sample(0.5)).mul(0.25));
    // The wider blend unless it reaches past the local range (it crossed another edge).
    const luma = dot(outer, LUMA);
    return vec4(select(luma.lessThan(lowest).or(luma.greaterThan(highest)), inner, outer), center.a);
  })();
  const pipeline = new RenderPipeline(renderer, fxaa ? output : frame);
  return {
    render: () => pipeline.render(),
    // The pipeline frees its quad only; the pass holds the full-size color and depth target.
    dispose: () => {
      pipeline.dispose();
      scenePass.dispose();
    },
  };
}
