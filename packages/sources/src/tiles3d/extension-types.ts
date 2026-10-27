// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** Public types of the 3D Tiles render extension (ADR 0141). */
import type { CreditProfile, RenderExtension, RenderExtensionContext, TaskTable, TileTransport } from '@vibeglobe/core';
import type { RequestEvent } from './fetcher.js';
import type { ModelWorker } from './model-decoder.js';
import type { Tileset } from './tileset.js';

/** A ray hit on the meshes, as the renderer reports it. */
export interface TileMeshHit {
  readonly key: number;
  readonly distanceMeters: number;
  /** World point, relative to the eye. */
  readonly point: readonly [number, number, number];
  readonly featureIds: Readonly<Record<string, number>>;
}

/** What the renderer gives the loader: meshes of decoded models (`threeTileMeshes` of `@vibeglobe/renderer/tiles3d`). */
export interface TileMeshes {
  /** Builds a decoded model (a `ModelDescription`) hidden; resolves with the bytes it holds. */
  add(key: number, model: unknown): Promise<number> | number;
  /** The content-to-world matrix, column-major, translation relative to the eye. */
  setMatrix(key: number, matrix: ArrayLike<number>): void;
  setVisible(key: number, visible: boolean): void;
  remove(key: number): void;
  raycast(origin: ArrayLike<number>, direction: ArrayLike<number>): TileMeshHit | undefined;
  dispose(): void;
}

/** Options of {@link tiles3d}. */
export interface Tiles3DOptions {
  /** The tileset JSON's URL. */
  readonly url: string;
  /** A name for errors and credits. */
  readonly id?: string;
  /** Creates the meshes from the extension's context (`threeTileMeshes` of `@vibeglobe/renderer/tiles3d`). */
  readonly meshes: (context: RenderExtensionContext) => TileMeshes;
  /** Refine while a tile's screen-space error is above this many pixels; default 16. */
  readonly maximumScreenSpaceError?: number;
  /** Bytes of loaded content kept (GPU and RAM, F462); default 256 MiB. */
  readonly memoryBudgetBytes?: number;
  /** How bytes are fetched; default `fetchTransport()`. */
  readonly transport?: TileTransport;
  /**
   * A task table with `parse-model` (`createModelTasks()` of `@vibeglobe/models`), run on the main thread when the
   * engine's worker program does not register the task yet (hook request E (1)); without it such tiles fail.
   */
  readonly modelTasks?: TaskTable;
  /**
   * The absolute URL where the application hosts Draco's `draco_decoder.wasm` (ADR 0015), loaded by the workers only
   * once a tileset with Draco content needs it (F463).
   */
  readonly dracoWasmUrl?: string;
  /** A worker of the application's own running `parse-model`, used before `modelTasks` (hook request E (1)). */
  readonly modelWorker?: ModelWorker;
  /** The provider profile: `displayOnly` refuses picking and every data access (F323, ADR 0031). */
  readonly profile?: CreditProfile;
  /** Contents loading at once, at most; default 32. */
  readonly maxLoading?: number;
  /** Receives every request event (tests, debugging). */
  readonly onRequest?: (event: RequestEvent) => void;
  /** Receives a tile that failed and why. */
  readonly onTileError?: (tileId: string, message: string) => void;
}

/** A picked feature. */
export interface Tiles3DPick {
  readonly tileId: string;
  /** The feature id (batch id or `EXT_mesh_features` id), undefined for content without features. */
  readonly featureId: number | undefined;
  /** Batch table or property table values of the feature, and the tile's and content's metadata. */
  readonly properties: Readonly<Record<string, unknown>>;
  readonly position: { readonly longitudeDeg: number; readonly latitudeDeg: number; readonly heightMeters: number };
  readonly distanceMeters: number;
}

/** A drawn tile, for the debug overlay. */
export interface Tiles3DDebugTile {
  readonly id: string;
  readonly level: number;
  readonly screenSpaceErrorPx: number;
  /** The tile's bounding volume center in ECEF meters. */
  readonly centerEcef: readonly number[];
}

/** Counters of the extension. */
export interface Tiles3DStats {
  readonly ready: boolean;
  readonly drawn: number;
  readonly loading: number;
  readonly loaded: number;
  readonly failed: number;
  readonly bytes: number;
  readonly budgetBytes: number;
  readonly evicted: number;
  /** Models decoded on the engine's workers, and on the main thread by the fallback task table. */
  readonly decodedInWorkers: number;
  readonly decodedInline: number;
}

/** The extension, as `Globe.addRenderExtension(tiles3d(…))` creates it, with the loader's own API. */
export interface Tiles3DExtension extends RenderExtension {
  /** Resolves once the tileset JSON is loaded and parsed. */
  readonly loaded: Promise<Tileset>;
  readonly stats: () => Tiles3DStats;
  /** The tiles drawn by the last frame with their level and screen-space error. */
  readonly debugTiles: () => Tiles3DDebugTile[];
  /** The feature under a canvas point (CSS pixels) in the last frame; undefined over no tile. */
  readonly pick: (xPx: number, yPx: number) => Tiles3DPick | undefined;
  /** The copyrights of the drawn tiles' content (`asset.copyright`), most frequent first (F470). */
  readonly copyrights: () => string[];
  /** The tile tree (data access: refused for a display-only source). */
  readonly tileset: () => Tileset | undefined;
}
