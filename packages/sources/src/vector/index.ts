/**
 * @packageDocumentation
 * The vector format adapters (F236–F239): GeoJSON, KML and KMZ, GPX and Mapbox Vector Tiles, with their worker task
 * table. They run in workers, so they live in their own entry point and stay out of the main-thread bundle.
 * @module @vibeglobe/sources/vector
 */
export { decodeMvt } from './mvt.js';
export type { MvtFeature, MvtLayer, MvtTile, MvtValue } from './mvt.js';
export { parseGeoJson } from './geojson.js';
export { parseKml } from './kml.js';
export type { AltitudeMode, GroundOverlay, KmlFeature, KmlStyle, ParsedKml } from './kml.js';
export { parseGpx } from './gpx.js';
export type { GpxFeature, ParsedGpx } from './gpx.js';
export type { FeatureIssue, Geometry, ParsedFeatures, Position, VectorFeature } from './features.js';
export { VECTOR_TASKS } from './tasks.js';
export type { VectorTaskInput } from './tasks.js';
