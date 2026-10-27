// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * OGC 3D Tiles (M13; ADR 0041): tileset and content parsing, implicit tiling, traversal by screen-space error with
 * REPLACE and ADD refinement, request priorities and cancellation, the content memory budget, and the render
 * extension that streams a tileset into a globe (`tiles3d`, ADR 0141) with the meshes of `@vibeglobe/renderer/tiles3d`.
 * @packageDocumentation
 */
export { TileContentCache } from './cache.js';
export type {
  TileMeshes,
  TileMeshHit,
  Tiles3DDebugTile,
  Tiles3DExtension,
  Tiles3DOptions,
  Tiles3DPick,
  Tiles3DStats,
} from './extension-types.js';
export type { RequestEvent } from './fetcher.js';
export type { ModelWorker } from './model-decoder.js';
export { gltfInfo } from './gltf-info.js';
export type { GltfInfo } from './gltf-info.js';
export { tiles3d } from './loader.js';
export { google3dTiles } from '../providers/google-3d-tiles-provider.js';
export type { Google3DTiles, Google3DTilesOptions } from '../providers/google-3d-tiles-provider.js';
export { batchProperties, MAX_CONTENT_BYTES, parseTileContent } from './content.js';
export type { BinaryTable, ContentError, ParsedContent } from './content.js';
export {
  applySubtree,
  attachSubtree,
  expandImplicitChildren,
  expandTemplate,
  morton,
  needsSubtree,
  parseSubtree,
  subdivideVolume,
  subtreeUri,
} from './implicit.js';
export type { Subtree } from './implicit.js';
export { propertyTableRow, resolveEntity, resolveValue } from './metadata.js';
export type { MetadataSchema, PropertyTable, SchemaProperty } from './metadata.js';
export { parseTileset, resolveUri, SUPPORTED_EXTENSIONS } from './tileset.js';
export type {
  ContentState,
  ImplicitCoordinates,
  ImplicitTiling,
  Tile3D,
  TileContent,
  Tileset,
  TilesetProblem,
} from './tileset.js';
export { requestsToCancel, screenSpaceError, selectTiles } from './traversal.js';
export type { TileRequest, TraversalCamera, TraversalOptions, TraversalResult } from './traversal.js';
export {
  boundingRadius,
  distanceToVolume,
  geodeticToEcef,
  IDENTITY,
  intersectsFrustum,
  multiply,
  transformPoint,
  transformVector,
  worldVolume,
} from './volumes.js';
export type { Mat4, Plane, WorldVolume } from './volumes.js';
export {
  contentToWorld,
  createViewFrame,
  screenRay,
  TilesetAnchor,
  traversalCamera,
  viewFrame,
  worldToEcef,
} from './view-frame.js';
export type { ViewFrame } from './view-frame.js';
