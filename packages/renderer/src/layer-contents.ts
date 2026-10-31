// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import {
  ATTRIBUTE_COMPONENTS,
  type BatchAttribute,
  type BatchKind,
  type BatchStringChannel,
  type FeatureGeometry,
} from '@vibeglobe/core';

/** What a batch holds on the CPU: per-feature attributes, uniform overrides, strings and geometry (ADR 0037). */
export interface BatchContents {
  readonly kind: BatchKind;
  count: number;
  /** Features the layer reserved room for; quad batches allocate their vertices for all of them (F372). */
  readonly capacity?: number;
  readonly attributes: Map<BatchAttribute, Float64Array>;
  readonly uniforms: Map<BatchAttribute, Float64Array>;
  readonly strings: Map<BatchStringChannel, string[]>;
  readonly geometry: Map<number, FeatureGeometry>;
}

/** Defaults of attributes a layer did not write. */
const DEFAULTS: Partial<Record<BatchAttribute, readonly number[]>> = {
  color: [1, 1, 1, 1],
  sizePx: [8],
  widthPx: [2],
  opacity: [1],
  visible: [1],
  offsetPx: [0, 0],
  heightMeters: [0],
  baseMeters: [0],
};

/** Component `component` of a feature's attribute: its uniform override, its own value, or the default. */
export function valueOf(batch: BatchContents, attribute: BatchAttribute, feature: number, component = 0): number {
  const uniform = batch.uniforms.get(attribute);
  if (uniform) return uniform[component] ?? 0;
  const values = batch.attributes.get(attribute);
  const own = values?.[feature * ATTRIBUTE_COMPONENTS[attribute] + component];
  return own ?? DEFAULTS[attribute]?.[component] ?? 0;
}

/** Whether a polygon batch rises off the ground: a feature with a height or a base other than 0 (KB-285). */
export function rises(batch: BatchContents): boolean {
  for (let feature = 0; feature < batch.count; feature++)
    if (valueOf(batch, 'heightMeters', feature) !== 0 || valueOf(batch, 'baseMeters', feature) !== 0) return true;
  return false;
}
