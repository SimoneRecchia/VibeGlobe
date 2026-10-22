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
export { classifyRings, clipRing, fillArea, signedArea, tessellateFill, tileClipRect } from './fill-tessellate.js';
export type { ClipRect, FillGeometry, TilePoint, TileRing } from './fill-tessellate.js';
export { clipLine, tessellateLine } from './line-tessellate.js';
export type { LineCap, LineGeometry, LineJoin, LineOptions } from './line-tessellate.js';
export {
  buildingHeight,
  DEFAULT_BUILDING_HEIGHTS,
  extrudeBuilding,
  FALLBACK_BUILDING_HEIGHT_METERS,
  flatMapHeightScale,
  LEVEL_HEIGHT_METERS,
  parseLength,
  resolveBuildingParts,
} from './buildings.js';
export type { BuildingFeature, BuildingHeight, ExtrusionGeometry, HeightSource } from './buildings.js';
