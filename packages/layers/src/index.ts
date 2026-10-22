/**
 * @packageDocumentation
 * Data layers: the layer stack, primitives, data-driven and zoom-dependent styles, clustering, label placement and
 * collision, the picking id scheme and feature interaction (ADR 0029).
 * @module @vibeglobe/layers
 */
export {
  ATTRIBUTE_COMPONENTS,
  ANCHORS,
  BATCH_ATTRIBUTES,
  RecordingRenderTarget,
  estimatedTextMeasurer,
} from './render-target.js';
export type {
  BatchAttribute,
  BatchDescriptor,
  BatchHandle,
  BatchKind,
  BatchStringChannel,
  FeatureGeometry,
  LayerRenderTarget,
  Placement,
  RecordedWrite,
  ScreenProjector,
  TextMeasurer,
} from './render-target.js';
export {
  MAX_PICK_FEATURE_INDEX,
  MAX_PICK_SLOTS,
  PickSlotTable,
  decodePickColor,
  encodePickColor,
  packPickId,
  pickFeatureIndex,
  pickNearest,
  pickSlot,
} from './picking.js';
export { FeatureStore } from './feature-store.js';
export type { FeatureId } from './feature-store.js';
export { StyleError, compileStyle, evaluateProperty } from './style.js';
export type {
  CompiledProperty,
  CompiledStyle,
  LayerStyle,
  StyleChannel,
  StyleExpression,
  StyleFeature,
} from './style.js';
export { LayerEmitter, ORDER_STRIDE } from './layer.js';
export type { FeatureEvent, FrameContext, Layer, LayerContext, LayerEvents, PickedFeature } from './layer.js';
export { LayerStack } from './layer-stack.js';
export type { LayerPosition } from './layer-stack.js';
export { DataLayer } from './data-layer.js';
export type { DataLayerOptions, DataLayerStats, FeatureUpdate, LayerData } from './data-layer.js';
export { LabelLayer } from './label-layer.js';
export type { LabelLayerOptions } from './label-layer.js';
export { LabelPlacer } from './label-placement.js';
export type { CollisionBox, PlacementInput, PlacementOptions } from './label-placement.js';
export { boundsOf, localClusterEngine } from './cluster.js';
export type { ClusterEngine, ClusterItem, ClusterOptions, GeoBoundsDeg } from './cluster.js';
export { ClusterLayer } from './cluster-layer.js';
export type { ClusterLayerOptions } from './cluster-layer.js';
export { InteractionController } from './interaction.js';
export type { PickProvider } from './interaction.js';
export { GeoJsonLayer } from './geojson-layer.js';
export type { GeoJsonLayerOptions } from './geojson-layer.js';
export { geojsonFormat, gpxFormat, kmlFormat, loadVectorData } from './vector-format.js';
export type { ParsedVectorData, VectorFormatAdapter, VectorInput, VectorSource } from './vector-format.js';
export { anchorOf, geometryFamily, toFeatureGeometry } from './geojson.js';
export type { Feature, FeatureCollection, Geometry, GeometryFamily, Position } from './geojson.js';
export { pointLayer, markerLayer, labelLayer, polylineLayer, polygonLayer, circleLayer } from './factories.js';
export { createGlobeLayers } from './globe-layers.js';
