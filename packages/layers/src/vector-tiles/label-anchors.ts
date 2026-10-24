// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Label anchors of one tile's symbol bucket (F449, ADR 0132): point labels at their feature's point, line labels every
 * `symbol-spacing` along their line, both fixed at the tile's own zoom (512-pixel tiles), so anchors do not move
 * while the camera zooms. Only anchors inside the tile's own square are kept (a road crossing a tile edge is labelled
 * by one tile), and each gets a stable id across tiles from the cross-tile index.
 */
import { BUCKET_EXTENT, type Bucket } from './layout-tile.js';
import { lineAnchors, type LineAnchor } from './line-labels.js';
import type { StyleLayer } from './style-layer.js';
import type { CrossTileSymbolIndex } from './symbol-placement.js';
import type { TilePoint } from './fill-tessellate.js';
import type { TileId } from './tile-pyramid.js';

/** Tile units per CSS pixel at a tile's own zoom. */
export const UNITS_PER_PX = BUCKET_EXTENT / 512;

/** One label anchor of a tile. */
export interface LabelAnchor {
  /** Stable id across tiles (`CrossTileSymbolIndex`). */
  readonly id: number;
  /** Index into the bucket's labels. */
  readonly label: number;
  readonly x: number;
  readonly y: number;
  /** Line labels: the anchor on the line and the line itself. */
  readonly onLine?: { readonly anchor: LineAnchor; readonly line: readonly TilePoint[] };
}

/** The anchors of a symbol bucket; `textWidthPx` gives a label's width at 24 px (for the label length on lines). */
export function labelAnchors(
  layer: StyleLayer,
  bucket: Bucket,
  tile: TileId,
  index: CrossTileSymbolIndex,
  textWidthPx: (label: number) => number | undefined,
): LabelAnchor[] {
  const labels = bucket.labels ?? [];
  const n = 2 ** tile.z;
  const raw: Omit<LabelAnchor, 'id'>[] = [];
  labels.forEach((label, i) => {
    if (label.anchor !== undefined) {
      raw.push({ label: i, x: label.anchor[0], y: label.anchor[1] });
      return;
    }
    if (label.line === undefined) return;
    const feature = bucket.features[label.feature];
    const size = Number(layer.layout('text-size', tile.z, feature)) || 16;
    const width = textWidthPx(i);
    if (width === undefined) return;
    const anchors = lineAnchors(label.line, {
      spacing: (Number(layer.layout('symbol-spacing', tile.z, feature)) || 250) * UNITS_PER_PX,
      labelLength: ((width * size) / 24) * UNITS_PER_PX,
      maxAngleDeg: Number(layer.layout('text-max-angle', tile.z, feature)) || 45,
      extent: BUCKET_EXTENT,
    });
    for (const anchor of anchors)
      raw.push({ label: i, x: anchor.x, y: anchor.y, onLine: { anchor, line: label.line } });
  });
  const ids = index.addTile(
    `${tile.z}/${tile.x}/${tile.y}|${layer.id}`,
    tile.z,
    raw.map((a) => ({
      key: `${layer.id}|${labels[a.label]?.text ?? ''}`,
      worldX: (tile.x + a.x / BUCKET_EXTENT) / n,
      worldY: (tile.y + a.y / BUCKET_EXTENT) / n,
    })),
  );
  return raw.map((a, i) => ({ ...a, id: ids[i] ?? 0 }));
}
