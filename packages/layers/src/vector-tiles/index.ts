/**
 * Vector tiles (M13, computational parts; ADR 0034): MapLibre style evaluation and validation, layer fades,
 * tessellation, text shaping, label placement and building extrusion. The renderer draws what these modules build.
 * @packageDocumentation
 */
export { LAYER_FADE_MS, LayerFader } from './layer-fader.js';
export { plainValue, STYLE_LAYER_TYPES, StyleLayer } from './style-layer.js';
export type {
  FeatureStateMap,
  LayerProblem,
  StyleColor,
  StyleFeatureInput,
  StyleLayerJson,
  StyleLayerType,
} from './style-layer.js';
export { changeNeedsRelayout, VectorStyle } from './vector-style.js';
export type { StyleChange, StyleChangeKind, StyleProblem, StyleSourceJson } from './vector-style.js';
