// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * @hotpath Rewrites one point's quad in place, every frame a live feed moves or recolors points (F378): reads the
 * batch's typed arrays and writes the mesh's, allocating nothing (the general quad path builds arrays per feature).
 * @benchmark e2e/globe-allocation.spec.ts
 */
import { ATTRIBUTE_COMPONENTS, writeLayerVertex, type BatchAttribute, type LayerGround } from '@vibeglobe/core';
import { nearestLon, originLonDeg, wrappedLon } from './layer-antimeridian.js';
import type { BatchContents } from './layer-contents.js';
import type { LayerArrays } from './layer-geometry.js';

/** Unit-square corners of a quad, x then y, in vertex order. */
const CORNERS = Float64Array.of(-1, -1, 1, -1, 1, 1, -1, 1);
/** A box's shift from its anchor in half-sizes, by `ANCHORS` index (y up). */
const ANCHOR_X = Float64Array.of(0, 1, -1, 0, 0, 1, -1, 1, -1);
const ANCHOR_Y = Float64Array.of(0, 0, 0, -1, 1, -1, -1, 1, 1);
/** Defaults of the attributes a layer did not write, as `layer-contents.ts`. */
const DEFAULT_COLOR = Float64Array.of(1, 1, 1, 1);
const DEG = Math.PI / 180;
/** The feature's linear RGBA. */
const rgba = new Float64Array(4);

/** The array an attribute's values come from: its uniform override, or the features' own values, or none. */
function columnOf(batch: BatchContents, attribute: BatchAttribute): Float64Array | undefined {
  return batch.uniforms.get(attribute) ?? batch.attributes.get(attribute);
}

/** Where a feature's components start in {@link columnOf}'s array (an integer: no number is boxed). */
function baseOf(batch: BatchContents, attribute: BatchAttribute, feature: number): number {
  return batch.uniforms.has(attribute) ? 0 : feature * ATTRIBUTE_COMPONENTS[attribute];
}

/**
 * Writes the four vertices of point `feature` into `arrays`, as `buildQuads` lays them out: the anchor on the ground
 * when there is one, the color in linear light with its opacity, the corners offset in pixels by the radius, anchor,
 * offset and rotation (a hidden point collapses to its anchor, transparent). Attribute values are read inline from the
 * typed arrays: a function returning a double boxes it where V8 does not inline it.
 */
export function writePointQuad(
  batch: BatchContents,
  arrays: LayerArrays,
  feature: number,
  ground: LayerGround | undefined,
): void {
  const position = columnOf(batch, 'position');
  const p = baseOf(batch, 'position', feature);
  const lonDeg = position?.[p] ?? 0;
  const latDeg = position?.[p + 1] ?? 0;
  let height = position?.[p + 2] ?? 0;
  if (ground !== undefined) height += ground.heightAt(wrappedLon(lonDeg), latDeg);
  const visible = columnOf(batch, 'visible');
  const shown = visible?.[baseOf(batch, 'visible', feature)] ?? 1;
  const opacity = columnOf(batch, 'opacity');
  const alpha = (opacity?.[baseOf(batch, 'opacity', feature)] ?? 1) * shown;
  const color = columnOf(batch, 'color');
  const k = baseOf(batch, 'color', feature);
  for (let c = 0; c < 3; c++) {
    const value = color?.[k + c] ?? DEFAULT_COLOR[c] ?? 1;
    // Style colors are sRGB (CSS); the renderer blends in linear light.
    rgba[c] = shown > 0 ? (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) : 0;
  }
  rgba[3] = shown > 0 ? (color?.[k + 3] ?? 1) * alpha : 0;
  const size = columnOf(batch, 'sizePx');
  const radius = shown > 0 ? (size?.[baseOf(batch, 'sizePx', feature)] ?? 8) : 0;
  const anchors = columnOf(batch, 'anchor');
  const anchor = anchors?.[baseOf(batch, 'anchor', feature)] ?? 0;
  const offset = columnOf(batch, 'offsetPx');
  const o = baseOf(batch, 'offsetPx', feature);
  const dx = (offset?.[o] ?? 0) + (ANCHOR_X[anchor] ?? 0) * radius;
  const dy = -(offset?.[o + 1] ?? 0) + (ANCHOR_Y[anchor] ?? 0) * radius;
  const rotation = columnOf(batch, 'rotationDeg');
  const angle = -(rotation?.[baseOf(batch, 'rotationDeg', feature)] ?? 0) * DEG;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // The four corners share the anchor's attributes: computed once, copied to the other three.
  const v0 = feature * 4;
  writeLayerVertex(arrays, v0, nearestLon(lonDeg, originLonDeg(arrays.origin)), latDeg, arrays.origin);
  for (let corner = 0; corner < 4; corner++) {
    const v = v0 + corner;
    if (corner > 0) {
      for (let i = 0; i < 3; i++) arrays.positions[v * 3 + i] = arrays.positions[v0 * 3 + i] ?? 0;
      for (let i = 0; i < 3; i++) arrays.normals[v * 3 + i] = arrays.normals[v0 * 3 + i] ?? 0;
      for (let i = 0; i < 4; i++) arrays.planes[v * 4 + i] = arrays.planes[v0 * 4 + i] ?? 0;
    }
    arrays.heights[v] = height;
    for (let c = 0; c < 4; c++) arrays.colors[v * 4 + c] = rgba[c] ?? 0;
    const sx = CORNERS[corner * 2] ?? 0;
    const sy = CORNERS[corner * 2 + 1] ?? 0;
    const x = sx * radius;
    const y = sy * radius;
    // corner.zw: the unit square of round points (a hidden one: 2, no circle).
    arrays.corners[v * 4] = shown > 0 ? dx + x * cos - y * sin : 0;
    arrays.corners[v * 4 + 1] = shown > 0 ? dy + x * sin + y * cos : 0;
    arrays.corners[v * 4 + 2] = shown > 0 ? sx : 2;
    arrays.corners[v * 4 + 3] = shown > 0 ? sy : 2;
    arrays.uvs[v * 4] = -1;
    arrays.uvs[v * 4 + 1] = -1;
    arrays.uvs[v * 4 + 2] = 0;
    arrays.uvs[v * 4 + 3] = 0;
  }
}
