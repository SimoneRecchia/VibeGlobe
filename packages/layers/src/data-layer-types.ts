import type { GeoPosition } from '@vibeglobe/core';
import type { Geometry } from './geojson.js';

/** A change to one feature. */
export interface FeatureUpdate {
  /** New position (points, markers, labels) as a geographic position or GeoJSON coordinates. */
  readonly position?: GeoPosition | readonly number[];
  readonly geometry?: Geometry;
  /** Replaces the properties when `replace` is true, otherwise merges into them. */
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly replace?: boolean;
}

/** Counters for instrumentation (F372, F376): style evaluations and full re-evaluations of the layer. */
export interface DataLayerStats {
  featureEvaluations: number;
  /** Times every feature was re-evaluated (zoom-dependent per-feature styles while zooming, a new style). */
  fullEvaluations: number;
}
