/**
 * The 3D Tiles render extension (F461–F467; ADR 0141): `Globe.addRenderExtension(tiles3d({ url, meshes }))`. Each
 * frame it selects tiles by screen-space error (`selectTiles`, REPLACE and ADD, no holes), queues the content and
 * subtree requests by priority in front of the page's request pool (`context.network`), cancels those the view no
 * longer wants, parses tile formats on the main thread (headers only) and decodes glTF with the `parse-model` task on
 * the engine's worker pool (`context.workers`; Draco, meshopt), keeps loaded content within a byte budget (LRU), and
 * places the selected tiles' meshes relative to the eye, rigidly through the globe-to-flat morph. Picking returns the
 * feature, its batch table or `EXT_structural_metadata` properties and its position; for a display-only source
 * (Google, ADR 0031) every data access is refused (F323).
 */
import {
  ecefToGeodetic,
  GlobeError,
  type FrameView,
  type GeodeticRad,
  type RenderExtensionContext,
  type TransportResult,
  type WorkerPool,
} from '@vibeglobe/core';
import { fetchTransport } from '../fetch-transport.js';
import { TileContentCache } from './cache.js';
import { batchProperties, parseTileContent, type BinaryTable, type ParsedContent } from './content.js';
import type {
  TileMeshes,
  Tiles3DDebugTile,
  Tiles3DExtension,
  Tiles3DOptions,
  Tiles3DPick,
  Tiles3DStats,
} from './extension-types.js';
import { TileFetcher, type FetchHandle } from './fetcher.js';
import { gltfInfo, type GltfInfo } from './gltf-info.js';
import { applySubtree, parseSubtree, subtreeUri } from './implicit.js';
import { propertyTableRow } from './metadata.js';
import { parseTileset, type Tile3D, type Tileset } from './tileset.js';
import { selectTiles, type TraversalResult } from './traversal.js';
import {
  contentToWorld,
  createViewFrame,
  screenRay,
  TilesetAnchor,
  traversalCamera,
  viewFrame,
  worldToEcef,
  type ViewFrame,
} from './view-frame.js';
import { DecodeCancelled, ModelDecoder } from './model-decoder.js';
import { multiply, type Mat4 } from './volumes.js';

/** A decoded glTF of a tile, as one mesh. */
interface Piece {
  readonly key: number;
  /** Content-to-ECEF: the tile transform, RTC_CENTER, and glTF's +Y up turned to +Z up. */
  readonly matrix: Mat4;
  readonly batch: { readonly table: BinaryTable; readonly length: number } | undefined;
  readonly info: GltfInfo;
}

interface TileData {
  readonly pieces: Piece[];
}

interface Job {
  priority: number;
  cancelled: boolean;
  fetches: Set<FetchHandle>;
  tasks: Set<number>;
}

/** glTF's +Y up to 3D Tiles' +Z up (specification 1.0 §glTF transforms). */
const Y_UP_TO_Z_UP: Mat4 = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
const DEFAULT_BUDGET_BYTES = 256 * 1024 * 1024;
const RETRY_AFTER_MS = 2000;

/** Thrown by a cancelled job's awaits. */
class Cancelled extends Error {}

function translation(x: number, y: number, z: number): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

/** The glTF parts of a parsed content with their content-to-tile matrices. */
function gltfParts(content: ParsedContent): { glb: Uint8Array; local: Mat4; batch: Piece['batch'] }[] {
  switch (content.type) {
    case 'glb':
      return [{ glb: content.glb, local: Y_UP_TO_Z_UP, batch: undefined }];
    case 'b3dm': {
      const rtc = content.featureTable.json['RTC_CENTER'];
      const local = Array.isArray(rtc)
        ? multiply(translation(Number(rtc[0]) || 0, Number(rtc[1]) || 0, Number(rtc[2]) || 0), Y_UP_TO_Z_UP)
        : Y_UP_TO_Z_UP;
      return [{ glb: content.glb, local, batch: { table: content.batchTable, length: content.batchLength } }];
    }
    case 'cmpt':
      return content.tiles.flatMap(gltfParts);
    default:
      return [];
  }
}

const transient = (r: TransportResult): boolean =>
  r.kind === 'timeout' ||
  r.kind === 'network-error' ||
  (r.kind === 'status' && (r.status === 429 || r.status === 408 || r.status >= 500));

/** The loader behind the extension. */
class Tiles3DLoader implements Tiles3DExtension {
  readonly loaded: Promise<Tileset>;
  private root: Tileset | undefined;
  private anchor: TilesetAnchor | undefined;
  private readonly frameScratch: ViewFrame = createViewFrame();
  private readonly matrix = new Float64Array(16);
  private readonly fetcher: TileFetcher;
  private readonly meshes: TileMeshes;
  private readonly workers: WorkerPool | undefined;
  private readonly cache: TileContentCache;
  private readonly data = new Map<Tile3D, TileData>();
  private readonly jobs = new Map<Tile3D, Job>();
  private readonly retryAt = new Map<Tile3D, number>();
  private readonly keys = new Map<number, Tile3D>();
  private visible = new Set<number>();
  private nextKey = 1;
  private lastView: FrameView | undefined;
  private lastResult: TraversalResult | undefined;
  private readonly decoder: ModelDecoder;
  private disposed = false;
  private counters = { failed: 0, evicted: 0, decodedInWorkers: 0, decodedInline: 0 };

  constructor(
    private readonly options: Tiles3DOptions,
    private readonly context: RenderExtensionContext,
  ) {
    this.meshes = options.meshes(context.renderer);
    this.workers = context.workers;
    this.decoder = new ModelDecoder(context.workers, options.modelTasks);
    this.fetcher = new TileFetcher(options.transport ?? fetchTransport(), context.network, options.onRequest);
    this.cache = new TileContentCache(options.memoryBudgetBytes ?? DEFAULT_BUDGET_BYTES, (tile) => this.release(tile));
    this.loaded = this.loadRoot();
    this.loaded.catch(() => undefined);
  }

  private get name(): string {
    return this.options.id ?? this.options.url;
  }

  private async loadRoot(): Promise<Tileset> {
    const result = await this.fetcher.fetch(this.options.url, 0).result;
    if (result.kind !== 'ok')
      throw new GlobeError(
        'resource-failed',
        `3D Tiles '${this.name}': the tileset could not be loaded (${result.kind})`,
      );
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(result.bytes));
    } catch {
      throw new GlobeError('resource-failed', `3D Tiles '${this.name}': the tileset is not JSON`);
    }
    const { tileset, problems } = parseTileset(json, this.options.url);
    for (const problem of problems) this.options.onTileError?.(problem.path, problem.message);
    if (!tileset)
      throw new GlobeError('resource-failed', `3D Tiles '${this.name}': ${problems[0]?.message ?? 'invalid'}`);
    this.root = tileset;
    this.anchor = new TilesetAnchor(tileset.root.volume.center);
    this.context.requestRender();
    return tileset;
  }

  frame(view: FrameView): void {
    this.lastView = view;
    const root = this.root;
    const anchor = this.anchor;
    if (!root || !anchor || this.disposed) return;
    const frame = viewFrame(view, anchor, this.frameScratch);
    const result = selectTiles(root.root, traversalCamera(view, frame), {
      maximumScreenSpaceError: this.options.maximumScreenSpaceError ?? 16,
    });
    this.lastResult = result;
    this.place(result, frame);
    this.schedule(result);
    this.cache.touch(result.used);
    this.counters.evicted += this.cache.trim(result.used).length;
  }

  private place(result: TraversalResult, frame: ViewFrame): void {
    const visible = new Set<number>();
    for (const tile of result.render)
      for (const piece of this.data.get(tile)?.pieces ?? []) {
        this.meshes.setMatrix(piece.key, contentToWorld(frame, piece.matrix, this.matrix));
        if (!this.visible.has(piece.key)) this.meshes.setVisible(piece.key, true);
        visible.add(piece.key);
      }
    for (const key of this.visible) if (!visible.has(key)) this.meshes.setVisible(key, false);
    this.visible = visible;
  }

  private schedule(result: TraversalResult): void {
    const wanted = new Map<Tile3D, number>();
    for (const request of result.requests) wanted.set(request.tile, request.priority);
    for (const [tile, job] of this.jobs) {
      const priority = wanted.get(tile);
      if (priority === undefined) {
        // Traversal requests only unloaded tiles: one loading stays wanted while the view uses it.
        if (!result.used.has(tile)) this.cancel(tile, job);
      } else if (priority !== job.priority) {
        job.priority = priority;
        for (const fetch of job.fetches) fetch.setPriority(priority);
        for (const id of job.tasks) this.workers?.setPriority(id, priority);
      }
    }
    const now = Date.now();
    const limit = this.options.maxLoading ?? 32;
    for (const request of result.requests) {
      if (this.jobs.size >= limit) break;
      const { tile } = request;
      if (this.jobs.has(tile) || tile.state !== 'unloaded' || (this.retryAt.get(tile) ?? 0) > now) continue;
      const job: Job = { priority: request.priority, cancelled: false, fetches: new Set(), tasks: new Set() };
      this.jobs.set(tile, job);
      tile.state = 'loading';
      void this.run(tile, request.kind, job);
    }
    this.fetcher.pump();
  }

  private cancel(tile: Tile3D, job: Job): void {
    job.cancelled = true;
    for (const fetch of job.fetches) fetch.cancel();
    for (const id of job.tasks) this.workers?.cancel(id);
    this.jobs.delete(tile);
    if (tile.state === 'loading') tile.state = 'unloaded';
  }

  private async run(tile: Tile3D, kind: 'content' | 'subtree', job: Job): Promise<void> {
    try {
      if (kind === 'subtree') await this.loadSubtree(tile, job);
      else await this.loadContent(tile, job);
      if (this.jobs.get(tile) === job) this.jobs.delete(tile);
    } catch (error) {
      if (this.jobs.get(tile) === job) this.jobs.delete(tile);
      if (error instanceof Cancelled || error instanceof DecodeCancelled || job.cancelled || this.disposed) return;
      if (error instanceof RetryLater) {
        tile.state = 'unloaded';
        this.retryAt.set(tile, Date.now() + RETRY_AFTER_MS);
        setTimeout(() => this.context.requestRender(), RETRY_AFTER_MS);
        return;
      }
      tile.state = 'failed';
      this.counters.failed++;
      this.options.onTileError?.(tile.id, error instanceof Error ? error.message : String(error));
    }
    this.context.requestRender();
  }

  private async fetchBytes(url: string, job: Job): Promise<ArrayBuffer> {
    const handle = this.fetcher.fetch(url, job.priority);
    job.fetches.add(handle);
    const result = await handle.result;
    job.fetches.delete(handle);
    if (job.cancelled || result.kind === 'aborted') throw new Cancelled();
    if (result.kind === 'ok') return result.bytes;
    if (transient(result)) throw new RetryLater(url);
    throw new Error(`${url}: ${result.kind === 'status' ? `HTTP ${result.status}` : result.kind}`);
  }

  private async loadSubtree(tile: Tile3D, job: Job): Promise<void> {
    const uri = subtreeUri(tile);
    if (uri === undefined || tile.implicit === undefined) throw new Error('no subtree uri');
    const subtree = parseSubtree(await this.fetchBytes(uri, job), tile.implicit);
    if ('error' in subtree) throw new Error(subtree.error);
    applySubtree(tile, subtree);
    tile.state = 'unloaded';
  }

  private async loadContent(tile: Tile3D, job: Job): Promise<void> {
    const pieces: Piece[] = [];
    let bytes = 0;
    try {
      for (const content of tile.contents) {
        const parsed = parseTileContent(await this.fetchBytes(content.uri, job));
        if (parsed.type === 'error') throw new Error(`${content.uri}: ${parsed.message}`);
        if (parsed.type === 'tileset') {
          const { tileset, problems } = parseTileset(parsed.json, content.uri, tile);
          if (!tileset) throw new Error(`${content.uri}: ${problems[0]?.message ?? 'invalid tileset'}`);
          tile.children.push(tileset.root);
          bytes += 1024;
          continue;
        }
        const parts = gltfParts(parsed);
        if (parts.length === 0 && parsed.type !== 'cmpt')
          throw new Error(`${content.uri}: ${parsed.type} is not drawn`);
        for (const part of parts) {
          const model = await this.decode(part.glb, job);
          const key = this.nextKey++;
          bytes += await this.meshes.add(key, model);
          if (job.cancelled || this.disposed) {
            this.meshes.remove(key);
            throw new Cancelled();
          }
          pieces.push({
            key,
            matrix: multiply(tile.transform, part.local),
            batch: part.batch,
            info: gltfInfo(part.glb),
          });
          this.keys.set(key, tile);
        }
      }
    } catch (error) {
      for (const piece of pieces) this.removePiece(piece);
      throw error;
    }
    this.data.set(tile, { pieces });
    tile.bytes = bytes;
    tile.state = 'ready';
    this.cache.add(tile);
  }

  /** Decodes a GLB with `parse-model`, counting where it ran. */
  private async decode(glb: Uint8Array, job: Job): Promise<unknown> {
    const { model, inWorker } = await this.decoder.decode(glb, job.priority, job);
    if (job.cancelled) throw new Cancelled();
    if (inWorker) this.counters.decodedInWorkers++;
    else this.counters.decodedInline++;
    return model;
  }

  private removePiece(piece: Piece): void {
    this.meshes.remove(piece.key);
    this.keys.delete(piece.key);
    this.visible.delete(piece.key);
  }

  private release(tile: Tile3D): void {
    for (const piece of this.data.get(tile)?.pieces ?? []) this.removePiece(piece);
    this.data.delete(tile);
  }

  private refuseData(api: string): void {
    const profile = this.options.profile;
    if (profile?.displayOnly !== true) return;
    const rule = profile.id === undefined ? 'its provider profile' : `the '${profile.id}' profile`;
    throw new GlobeError(
      'display-only',
      `${api} is refused: source '${this.name}' is display only under ${rule} (profile.displayOnly; ADR 0031)`,
    );
  }

  pick = (xPx: number, yPx: number): Tiles3DPick | undefined => {
    this.refuseData('pick');
    const view = this.lastView;
    const anchor = this.anchor;
    if (!view || !anchor) return undefined;
    const ray = screenRay(view, xPx, yPx);
    const hit = this.meshes.raycast(ray.origin, ray.direction);
    const tile = hit && this.keys.get(hit.key);
    if (!hit || !tile) return undefined;
    const piece = this.data.get(tile)?.pieces.find((p) => p.key === hit.key);
    const properties: Record<string, unknown> = { ...tile.metadata };
    for (const content of tile.contents) Object.assign(properties, content.metadata);
    let featureId: number | undefined;
    const batchId = hit.featureIds['_BATCHID'];
    if (batchId !== undefined && piece?.batch) {
      featureId = batchId;
      Object.assign(properties, batchProperties(piece.batch.table, batchId, piece.batch.length));
    } else if (piece) {
      for (const [attribute, table] of Object.entries(piece.info.featureTables)) {
        const id = hit.featureIds[attribute];
        const propertyTable = piece.info.propertyTables[table];
        if (id === undefined || !propertyTable || !piece.info.schema) continue;
        featureId = id;
        Object.assign(properties, propertyTableRow(propertyTable, id, piece.info.views, piece.info.schema));
        break;
      }
      featureId ??= hit.featureIds['_FEATURE_ID_0'];
    }
    const ecef = worldToEcef(viewFrame(view, anchor, createViewFrame()), hit.point);
    const g: GeodeticRad = { longitudeRad: 0, latitudeRad: 0, heightMeters: 0 };
    ecefToGeodetic(ecef[0], ecef[1], ecef[2], g);
    return {
      tileId: tile.id,
      featureId,
      properties,
      position: {
        longitudeDeg: (g.longitudeRad * 180) / Math.PI,
        latitudeDeg: (g.latitudeRad * 180) / Math.PI,
        heightMeters: g.heightMeters,
      },
      distanceMeters: hit.distanceMeters,
    };
  };

  tileset = (): Tileset | undefined => {
    this.refuseData('tileset');
    return this.root;
  };

  copyrights = (): string[] => {
    const counts = new Map<string, number>();
    for (const tile of this.lastResult?.render ?? [])
      for (const piece of this.data.get(tile)?.pieces ?? [])
        for (const name of (piece.info.copyright ?? '').split(';')) {
          const trimmed = name.trim();
          if (trimmed !== '') counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
        }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => name);
  };

  stats = (): Tiles3DStats => ({
    ready: this.root !== undefined,
    drawn: this.lastResult?.render.length ?? 0,
    loading: this.jobs.size,
    loaded: this.cache.size,
    failed: this.counters.failed,
    bytes: this.cache.bytes,
    budgetBytes: this.cache.budgetBytes,
    evicted: this.counters.evicted,
    decodedInWorkers: this.counters.decodedInWorkers,
    decodedInline: this.counters.decodedInline,
  });

  debugTiles = (): Tiles3DDebugTile[] =>
    (this.lastResult?.render ?? []).map((tile) => ({
      id: tile.id,
      level: tile.depth,
      screenSpaceErrorPx: this.lastResult?.screenSpaceError.get(tile) ?? 0,
      centerEcef: tile.volume.center,
    }));

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [tile, job] of [...this.jobs]) this.cancel(tile, job);
    this.fetcher.dispose();
    this.meshes.dispose();
    this.data.clear();
    this.keys.clear();
  }
}

/** A request to try again later (a timeout, a network error, 429 or 5xx). */
class RetryLater extends Error {}

/**
 * The 3D Tiles render extension factory: `const tiles = globe.addRenderExtension(tiles3d({ url, meshes:
 * threeTileMeshes }))`. The created extension is also handed to `onCreate`, to reach its loader API.
 */
export function tiles3d(
  options: Tiles3DOptions,
  onCreate?: (extension: Tiles3DExtension) => void,
): (context: RenderExtensionContext) => Tiles3DExtension {
  return (context) => {
    const extension = new Tiles3DLoader(options, context);
    onCreate?.(extension);
    return extension;
  };
}
