// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The meshes of vector tile layers (ADR 0131): one per tile, style layer and part (a fill and its outline, F445), built
 * on first use, repainted in place when the paint or the zoom pair changes (F440, F446, F450), draped again when finer
 * terrain arrives within the frame's budget (F452), and freed when no frame drew them for a while.
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
import type { VectorMesh, VectorTileTarget } from './vector-target.js';

/** Frames a mesh stays after its last draw. */
const KEEP_FRAMES = 120;

interface TileMesh {
  readonly mesh: VectorMesh;
  readonly featureIndex: Uint32Array;
  readonly bucket: Bucket;
  readonly paint: MeshPaint;
  paintKey: string;
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

/** The meshes of one vector tile layer. */
export class TileMeshCache {
  private readonly meshes = new Map<string, TileMesh>();
  /** Set when a mesh waits for the next frame's draping budget. */
  drapePending = false;

  constructor(
    private readonly target: () => VectorTileTarget | undefined,
    private readonly grounds: TileGrounds,
    private readonly stateOf: (source: string, feature: BucketFeature) => FeatureStateMap | undefined,
    private readonly pattern: (name: string) => PatternRect | undefined,
  ) {}

  private options(bucket: Bucket, part: PaintPart | undefined): PaintOptions {
    return { part, pattern: this.pattern, progress: bucket.geometry?.progress };
  }

  /** The mesh of a tile's bucket for a layer (`part` 'outline': a fill's outline), or undefined when it has none. */
  get(
    from: MeshSource,
    layer: StyleLayer,
    zoomA: number,
    paintVersion: number,
    frame: number,
    part?: PaintPart,
  ): VectorMesh | undefined {
    const { loaded, tile, sourceId } = from;
    const key = `${sourceId}|${loaded?.key ?? tileKey(tile)}|${layer.id}|${loaded?.version ?? 0}|${part ?? ''}`;
    const paintKey = `${zoomA}|${paintVersion}`;
    let entry = this.meshes.get(key);
    const state = (f: BucketFeature) => this.stateOf(sourceId, f);
    if (entry === undefined) {
      entry = this.create(from, layer, zoomA, part, paintKey);
      if (entry === undefined) return undefined;
      this.meshes.set(key, entry);
    } else if (entry.paintKey !== paintKey) {
      meshPaint(layer, entry.bucket, entry.featureIndex, zoomA, state, entry.paint, this.options(entry.bucket, part));
      entry.mesh.update(entry.paint);
      entry.paintKey = paintKey;
    }
    if (entry.groundVersion !== this.grounds.version && this.grounds.active) {
      if (this.grounds.canDrape) {
        entry.groundVersion = this.grounds.version;
        entry.mesh.update({ ground: this.grounds.heights(tile, entry.tileXY, entry.ground) });
      } else this.drapePending = true;
    }
    entry.usedAt = frame;
    return entry.mesh;
  }

  /** Frees meshes not drawn for a while (their tile left the cache, or an older layout version). */
  evict(frame: number): void {
    for (const [key, entry] of this.meshes) {
      if (frame - entry.usedAt <= KEEP_FRAMES) continue;
      entry.mesh.dispose();
      this.meshes.delete(key);
    }
  }

  /** Forgets every mesh (the target frees them). */
  clear(): void {
    this.meshes.clear();
  }

  private create(
    { loaded, tile, sourceId }: MeshSource,
    layer: StyleLayer,
    zoomA: number,
    part: PaintPart | undefined,
    paintKey: string,
  ): TileMesh | undefined {
    const target = this.target();
    const type = part === 'outline' ? 'fill-outline' : layer.type;
    const bucket =
      loaded === undefined
        ? backgroundBucket(tile, layer.id)
        : loaded.buckets.find((b) => b.layerId === layer.id && b.type === type);
    const kind = meshKindOf(type);
    if (bucket === undefined || kind === undefined || target === undefined) return undefined;
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
      paintKey,
      tileXY: geometry.data.tile,
      ground,
      groundVersion,
      usedAt: 0,
    };
  }
}
