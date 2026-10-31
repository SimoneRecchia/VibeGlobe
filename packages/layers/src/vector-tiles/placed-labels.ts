// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The labels a frame placed, as a vector tile layer reports them (F449), read by a feature property and hidden while
 * kept placed (F652): an application that shows its own marker where a label stands hides that label, and the labels
 * around it stay where they are because it keeps its room in collision.
 */
import type { BucketFeature } from './layout-tile.js';
import type { ScreenBox } from './symbol-placement.js';

/** A placed label, for the debug API (F449). */
export interface PlacedLabel {
  readonly id: number;
  readonly layerId: string;
  readonly text: string;
  readonly boxes: readonly ScreenBox[];
  readonly opacity: number;
  /** The style source, the feature and the anchor's position, for picking (F459). */
  readonly source: string;
  readonly feature: BucketFeature;
  readonly position: { readonly longitudeDeg: number; readonly latitudeDeg: number };
  /** The anchor on screen in the frame that placed the label, CSS pixels (F652). */
  readonly screenPoint: { readonly xPx: number; readonly yPx: number };
}

/** A feature property value of a vector tile. */
export type LabelPropertyValue = string | number | boolean;

/**
 * Which labels of a symbol layer are hidden: every one (`true`), none (`false`), or those whose feature property has
 * one of the values.
 */
export type LabelsHidden = boolean | { readonly property: string; readonly values: Iterable<LabelPropertyValue> };

/** The hidden labels of each symbol layer of a vector tile layer. */
export class HiddenLabels {
  private readonly layers = new Map<string, true | { readonly property: string; readonly values: Set<unknown> }>();

  /** Whether no label of any layer is hidden. */
  get none(): boolean {
    return this.layers.size === 0;
  }

  /** Sets which labels of a style layer are hidden, replacing the layer's previous choice. */
  set(layerId: string, labels: LabelsHidden): void {
    if (labels === false) this.layers.delete(layerId);
    else if (labels === true) this.layers.set(layerId, true);
    else this.layers.set(layerId, { property: labels.property, values: new Set(labels.values) });
  }

  /** Whether the label of a feature on a style layer is hidden. */
  has(layerId: string, feature: BucketFeature): boolean {
    const hidden = this.layers.get(layerId);
    return hidden === true || (hidden !== undefined && hidden.values.has(feature.properties[hidden.property]));
  }
}

/** The labels of a style layer by the value of a feature property; of several labels with the same value, the first. */
export function labelsBy(
  labels: readonly PlacedLabel[],
  layerId: string,
  property: string,
): Map<LabelPropertyValue, PlacedLabel> {
  const out = new Map<LabelPropertyValue, PlacedLabel>();
  for (const label of labels) {
    const value = label.feature.properties[property];
    if (label.layerId === layerId && value !== undefined && !out.has(value)) out.set(value, label);
  }
  return out;
}

/** The placed labels that are drawn: all but the hidden ones. */
export function drawnOf(
  candidates: readonly { readonly id: number; readonly hidden: boolean }[],
  placed: ReadonlySet<number>,
): Set<number> {
  const drawn = new Set(placed);
  for (const c of candidates) if (c.hidden) drawn.delete(c.id);
  return drawn;
}
