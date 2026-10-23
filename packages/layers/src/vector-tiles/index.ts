/**
 * Vector tiles (M13, computational parts; ADR 0041): MapLibre style evaluation and validation, layer fades,
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
export {
  decodeGlyphs,
  GLYPH_RANGE_SIZE,
  glyphRanges,
  GlyphStore,
  glyphUrl,
  MAX_GLYPH_CODE_POINT,
  parseSpriteIndex,
  spriteUrls,
} from './glyphs.js';
export type { Glyph, SpriteIcon, SpriteSheetUrls } from './glyphs.js';
export { allowsIdeographicBreak, DEFAULT_SHAPING, ONE_EM_PX, shapeText } from './text-shaping.js';
export type { GlyphLookup, PositionedGlyph, Shaping, ShapingOptions, TextAnchor } from './text-shaping.js';
export { lineAnchors, placeGlyphsAlongLine, pointAlong } from './line-labels.js';
export type { GlyphOnLine, LineAnchor, LineAnchorOptions } from './line-labels.js';
export { byPriority, CrossTileSymbolIndex, placeSymbols, SymbolFader } from './symbol-placement.js';
export type { ScreenBox, SymbolCandidate, TileSymbol } from './symbol-placement.js';
export {
  brunnel,
  localizedName,
  localizedTextField,
  PLACE_CLASSES,
  placePriority,
  ROAD_CLASSES,
  roadClass,
  roadDrawOrder,
} from './osm.js';
export type { RoadClass } from './osm.js';
export {
  ancestorAt,
  inCoverage,
  overzoom,
  retainedTiles,
  tileKey,
  tilesToDraw,
  tilesToRequest,
  toTargetTile,
} from './tile-pyramid.js';
export type { OverzoomTransform, SourceCoverage, TileDraw, TileId } from './tile-pyramid.js';
export { BUCKET_BUFFER, BUCKET_EXTENT, layoutVectorTile, SIDE_STEP_UNITS, VECTOR_TILE_TASKS } from './layout-tile.js';
export type { Bucket, BucketFeature, BucketGeometry, BucketLabel, LayoutInput } from './layout-tile.js';
export {
  densifyLine,
  globeVertices,
  maxEdgeUnits,
  subdividedFill,
  tileOrigin,
  tileToLonLat,
} from './globe-vertices.js';
export type { GlobeVertices } from './globe-vertices.js';
export { addVectorTiles } from './vector-tile-layer.js';
export type { VectorTileLayer, VectorTilesOptions } from './vector-tile-layer.js';
export { VectorTileLoader } from './tile-loader.js';
export type { LoadedTile, TileLoaderOptions, WantedTile } from './tile-loader.js';
export { meshGeometry } from './tile-meshes.js';
export type { MeshGeometry } from './tile-meshes.js';
export { linearColor, meshKindOf, meshPaint, zoomBracket } from './vector-paint.js';
export type { MeshPaint } from './vector-paint.js';
export { viewTargets } from './view-tiles.js';
export type { SurfaceTileRef } from './view-tiles.js';
export type {
  AtlasRect,
  LabelQuads,
  RasterizedGlyph,
  VectorAtlas,
  VectorDraw,
  VectorLayerDraws,
  VectorMesh,
  VectorMeshData,
  VectorMeshKind,
  VectorMeshUpdate,
  VectorTileTarget,
} from './vector-target.js';
