// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** Factory functions of the built-in layer kinds (docs/plan/api.md: `globe.layers.add(pointLayer({ ... }))`). */
import { ClusterLayer, type ClusterLayerOptions } from './cluster-layer.js';
import { DataLayer, type DataLayerOptions } from './data-layer.js';
import { LabelLayer, type LabelLayerOptions } from './label-layer.js';
import type { ClusterOptions } from './cluster.js';

/** Points styled with `circle-*` properties; clustered when `cluster` is given. */
export function pointLayer(options: DataLayerOptions & { readonly cluster?: ClusterOptions } = {}): DataLayer {
  const { cluster, ...rest } = options;
  if (cluster === undefined) return new DataLayer('point', rest);
  return new ClusterLayer({ ...(rest as ClusterLayerOptions), cluster });
}

/** Markers (billboard images) styled with `icon-*` properties. */
export function markerLayer(options: DataLayerOptions = {}): DataLayer {
  return new DataLayer('marker', options);
}

/** Labels styled with `text-*` properties, with collision and fades. */
export function labelLayer(options: LabelLayerOptions = {}): LabelLayer {
  return new LabelLayer(options);
}

/** Polylines styled with `line-*` properties. */
export function polylineLayer(options: DataLayerOptions = {}): DataLayer {
  return new DataLayer('polyline', options);
}

/** Polygons styled with `fill-*` and `fill-extrusion-*` properties. */
export function polygonLayer(options: DataLayerOptions = {}): DataLayer {
  return new DataLayer('polygon', options);
}

/** Geodesic circles and ellipses styled with `fill-*` properties. */
export function circleLayer(options: DataLayerOptions = {}): DataLayer {
  return new DataLayer('circle', options);
}
