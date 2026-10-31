// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The meshes of vector tile layers (ADR 0131): one per tile, style layer and part (a fill and its outline, F445), built
 * on first use, repainted in place when the paint or the zoom pair changes (F440, F446, F450), draped again when finer
 * terrain arrives within the frame's budget (F452), and freed when no frame drew them for a while. Building and
 * repainting share a time budget per frame (KB-244): tiles past it wait for the next frames, drawn meanwhile by the kept
 * mesh of a tile around or inside them, so a zoom level crossed or a layer appearing never stalls a frame.
 */
import type { TileGrounds } from './drape.js';
import { tileOrigin } from './globe-vertices.js';
import type { Bucket, BucketFeature } from './layout-tile.js';
import type { FeatureStateMap, StyleLayer } from './style-layer.js';
import type { LoadedTile } from './tile-loader.js';
import { backgroundBucket, meshGeometry } from './tile-meshes.js';
import { tileKey, type TileId } from './tile-pyramid.js';
import {
  meshKindOf,
  meshPaint,
  type MeshPaint,
  type PaintOptions,
  type PaintPart,
  type PatternRect,
} from './vector-paint.js';
import type { StyleChange } from './vector-style.js';
import type { VectorMesh, VectorTileTarget } from './vector-target.js';

/** Frames a mesh stays after its last draw. */
const KEEP_FRAMES = 120;
/** Main-thread time per frame for building and repainting meshes; one is built in every frame whatever it costs. */
const BUILD_BUDGET_MS = 6;

/** What {@link TileMeshCache.get} returns for a mesh the frame's budget left for later. */
export const DEFERRED = 'deferred';

/** A mesh to draw, with the lower zoom of the pair its paint was evaluated for. */
export interface PaintedMesh {
  readonly mesh: VectorMesh;
  readonly zoomA: number;
}

/** A kept mesh drawn for a region of the map while that region's own mesh waits for the budget. */
export interface StandIn extends PaintedMesh {
  readonly tile: TileId;
}

interface TileMesh {
  readonly mesh: VectorMesh;
  readonly featureIndex: Uint32Array;
  readonly bucket: Bucket;
  readonly paint: MeshPaint;
  /** The zoom pair (its lower zoom) and paint version the paint was evaluated for. */
  paintZoomA: number;
  paintVersion: number;
  /** Tile units of the vertices and their draped heights, with the terrain version they were draped from. */
  readonly tileXY: Float32Array;
  readonly ground: Float32Array;
  groundVersion: number;
  usedAt: number;
}

/** A tile's bucket to draw: from a loaded vector tile, or the background's square (no source). */
export interface MeshSource {
  readonly sourceId: string;
  readonly loaded: LoadedTile | undefined;
  readonly tile: TileId;
}

const layerKey = (sourceId: string, layerId: string, part: PaintPart | undefined) =>
  `${sourceId}|${layerId}|${part ?? ''}`;

/** A tile's number among all tiles, level by level: exact to level 26, with no string to build (KB-283). */
const tileIndex = (z: number, x: number, y: number) => (4 ** z - 1) / 3 + y * 2 ** z + x;

/** The meshes of one vector tile layer. */
export class TileMeshCache {
  private readonly meshes = new Map<string, TileMesh>();
  /** Per source, layer and part, then per tile ({@link tileIndex}): the last mesh built, whatever the data version. */
  private readonly latest = new Map<string, Map<number, TileMesh>>();
  private deadline = 0;
  private built = 0;
  /** Set when a mesh waits for the next frame's budget, to build, repaint or drape. */
  pending = false;

  constructor(
    private readonly target: () => VectorTileTarget | undefined,
    private readonly grounds: TileGrounds,
    private readonly stateOf: (source: string, feature: BucketFeature) => FeatureStateMap | undefined,
    private readonly pattern: (name: string) => PatternRect | undefined,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Starts a frame: opens its budget for building and repainting meshes. */
  beginFrame(): void {
    this.deadline = this.now() + BUILD_BUDGET_MS;
    this.built = 0;
    this.pending = false;
  }

  /** Whether the frame's budget allows building or repainting another mesh; if not, a frame is owed. */
  private budgetLeft(): boolean {
    if (this.built === 0 || this.now() < this.deadline) return true;
    this.pending = true;
    return false;
  }

  private options(bucket: Bucket, part: PaintPart | undefined): PaintOptions {
    return { part, pattern: this.pattern, progress: bucket.geometry?.progress };
  }

  /**
   * The mesh of a tile's bucket for a layer (`part` 'outline': a fill's outline), undefined when it has none, or
   * {@link DEFERRED} when the frame's budget is spent before it could be built. A new paint version repaints at once;
   * a new zoom pair waits for the budget, the mesh drawn meanwhile with the pair it has (`zoomA`).
   */
  get(
    from: MeshSource,
    layer: StyleLayer,
    zoomA: number,
    paintVersion: number,
    frame: number,
    part?: PaintPart,
  ): PaintedMesh | typeof DEFERRED | undefined {
    const { loaded, tile, sourceId } = from;
    const key = `${sourceId}|${loaded?.key ?? tileKey(tile)}|${layer.id}|${loaded?.version ?? 0}|${part ?? ''}`;
    let entry = this.meshes.get(key);
    const state = (f: BucketFeature) => this.stateOf(sourceId, f);
    if (entry === undefined) {
      const bucket = bucketOf(from, layer, part);
      if (bucket === undefined) return undefined;
      if (!this.budgetLeft()) return DEFERRED;
      this.built++;
      entry = this.create(from, bucket, layer, zoomA, part, paintVersion);
      if (entry === undefined) return undefined;
      this.meshes.set(key, entry);
      const ofLayer = layerKey(sourceId, layer.id, part);
      const byTile = this.latest.get(ofLayer) ?? this.latest.set(ofLayer, new Map()).get(ofLayer);
      byTile?.set(tileIndex(tile.z, tile.x, tile.y), entry);
    } else if (entry.paintVersion !== paintVersion || (entry.paintZoomA !== zoomA && this.budgetLeft())) {
      this.built++;
      meshPaint(layer, entry.bucket, entry.featureIndex, zoomA, state, entry.paint, this.options(entry.bucket, part));
      entry.mesh.update(entry.paint);
      entry.paintZoomA = zoomA;
      entry.paintVersion = paintVersion;
    }
    if (entry.groundVersion !== this.grounds.version && this.grounds.active) {
      if (this.grounds.canDrape) {
        entry.groundVersion = this.grounds.version;
        entry.mesh.update({ ground: this.grounds.heights(tile, entry.tileXY, entry.ground) });
      } else this.pending = true;
    }
    entry.usedAt = frame;
    return { mesh: entry.mesh, zoomA: entry.paintZoomA };
  }

  /**
   * Kept meshes that draw `region` (a tile's square) while its own mesh waits: the nearest tile containing it, else
   * its children's; each with the tile it belongs to, to clip it to the region.
   */
  standIns(sourceId: string, region: TileId, layerId: string, part: PaintPart | undefined, frame: number): StandIn[] {
    const byTile = this.latest.get(layerKey(sourceId, layerId, part));
    if (byTile === undefined) return [];
    const kept = (z: number, x: number, y: number): StandIn | undefined => {
      const entry = byTile.get(tileIndex(z, x, y));
      if (entry === undefined) return undefined;
      entry.usedAt = frame;
      return { mesh: entry.mesh, zoomA: entry.paintZoomA, tile: { z, x, y } };
    };
    for (let z = region.z, x = region.x, y = region.y; z >= 0; z--, x = Math.floor(x / 2), y = Math.floor(y / 2)) {
      const around = kept(z, x, y);
      if (around !== undefined) return [around];
    }
    const children: StandIn[] = [];
    for (let i = 0; i < 4; i++) {
      const child = kept(region.z + 1, region.x * 2 + (i % 2), region.y * 2 + Math.floor(i / 2));
      if (child !== undefined) children.push(child);
    }
    return children;
  }

  /** Frees meshes not drawn for a while (their tile left the cache, or an older layout version). */
  evict(frame: number): void {
    for (const [key, entry] of this.meshes) {
      if (frame - entry.usedAt <= KEEP_FRAMES) continue;
      entry.mesh.dispose();
      this.meshes.delete(key);
    }
    for (const [key, byTile] of this.latest) {
      for (const [tile, entry] of byTile) if (frame - entry.usedAt > KEEP_FRAMES) byTile.delete(tile);
      if (byTile.size === 0) this.latest.delete(key);
    }
  }

  /** Forgets every mesh (the target frees them). */
  clear(): void {
    this.meshes.clear();
    this.latest.clear();
  }

  private create(
    { tile, sourceId }: MeshSource,
    bucket: Bucket,
    layer: StyleLayer,
    zoomA: number,
    part: PaintPart | undefined,
    paintVersion: number,
  ): TileMesh | undefined {
    const target = this.target();
    const kind = meshKindOf(part === 'outline' ? 'fill-outline' : layer.type);
    if (kind === undefined || target === undefined) return undefined;
    const geometry = meshGeometry(kind, bucket, tileOrigin(tile));
    if (geometry === undefined) return undefined;
    const paint = meshPaint(
      layer,
      bucket,
      geometry.featureIndex,
      zoomA,
      (f) => this.stateOf(sourceId, f),
      undefined,
      this.options(bucket, part),
    );
    const groundVersion = this.grounds.version;
    const ground = this.grounds.heights(tile, geometry.data.tile, geometry.data.ground);
    const mesh = target.createMesh({ ...geometry.data, ...paint, ground });
    return {
      mesh,
      featureIndex: geometry.featureIndex,
      bucket,
      paint,
      paintZoomA: zoomA,
      paintVersion,
      tileXY: geometry.data.tile,
      ground,
      groundVersion,
      usedAt: 0,
    };
  }
}

/** The bucket a tile draws for a layer and part: its source's, or the background's square. */
function bucketOf({ loaded, tile }: MeshSource, layer: StyleLayer, part: PaintPart | undefined): Bucket | undefined {
  if (loaded === undefined) return backgroundBucket(tile, layer.id);
  const type = part === 'outline' ? 'fill-outline' : layer.type;
  return loaded.buckets.find((b) => b.layerId === layer.id && b.type === type);
}

/**
 * Paint versions per layer: a paint change restamps only its layer, so the others keep their meshes' paint; a feature
 * state restamps every layer; visibility and zoom ranges change no paint (the fades follow them).
 */
export class PaintStamps {
  private last = 1;
  private all = 1;
  private readonly byLayer = new Map<string, number>();

  /** Records a runtime style change that keeps the layout. */
  changed(change: StyleChange): void {
    if (change.kind === 'paint') this.byLayer.set(change.layerId, ++this.last);
    else if (change.kind !== 'visibility' && change.kind !== 'zoom-range') this.all = ++this.last;
  }

  /** Records a feature state change. */
  featureStateChanged(): void {
    this.all = ++this.last;
  }

  /** The paint version of a layer's meshes. */
  of(layerId: string): number {
    return Math.max(this.all, this.byLayer.get(layerId) ?? 0);
  }
}
