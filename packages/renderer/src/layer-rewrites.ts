// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { writeLayerVertex, type LayerGround } from '@vibeglobe/core';
import type { BatchContents } from './layer-contents.js';
import { nearestLon, originLonDeg } from './layer-antimeridian.js';
import { colorOf, HIDDEN_UV, quadVertices, type LayerArrays, type QuadImages } from './layer-geometry.js';
import { writePointQuad } from './layer-points.hot.js';

/**
 * Rewrites the vertices of features [first, end) of a quad batch in place (F376, F377); returns false when its arrays do
 * not hold them (the batch must be rebuilt).
 */
export function rewriteQuads(
  batch: BatchContents,
  arrays: LayerArrays,
  first: number,
  end: number,
  images: QuadImages | undefined,
  ground: LayerGround | undefined,
): boolean {
  if (end * 4 > arrays.vertices) return false;
  if (batch.kind === 'point') {
    // Points have no image: the allocation-free path of live feeds (F378).
    for (let feature = first; feature < end; feature++) writePointQuad(batch, arrays, feature, ground);
    return true;
  }
  for (let feature = first; feature < end; feature++) {
    const q = quadVertices(batch, feature, images);
    const height = q.height + (ground?.heightAt(q.lon, q.lat) ?? 0);
    const lon = nearestLon(q.lon, originLonDeg(arrays.origin));
    for (let c = 0; c < 4; c++) {
      const v = feature * 4 + c;
      writeLayerVertex(arrays, v, lon, q.lat, arrays.origin);
      arrays.heights[v] = height;
      arrays.colors.set(q.color, v * 4);
      arrays.corners.set(q.corners[c] ?? [], v * 4);
      arrays.uvs.set(q.uvs[c] ?? HIDDEN_UV, v * 4);
    }
  }
  return true;
}

/**
 * Recolors features [first, end) of a line or flat polygon batch in place (KB-350); returns false when its arrays do
 * not hold them (the batch must be rebuilt).
 */
export function recolor(batch: BatchContents, arrays: LayerArrays, first: number, end: number): boolean {
  const starts = arrays.starts;
  if (!starts || end >= starts.length) return false;
  for (let feature = first; feature < end; feature++) {
    const color = colorOf(batch, feature);
    for (let v = starts[feature] ?? 0; v < (starts[feature + 1] ?? 0); v++) arrays.colors.set(color, v * 4);
  }
  return true;
}

/** Stands the vertices of a line or polygon batch on the terrain known now, in place (KB-349). */
export function reground(arrays: LayerArrays, sources: Float64Array, ground: LayerGround): void {
  for (let v = 0; v < arrays.vertices; v++)
    arrays.heights[v] = (sources[v * 3 + 2] ?? 0) + ground.heightAt(sources[v * 3] ?? 0, sources[v * 3 + 1] ?? 0);
}
