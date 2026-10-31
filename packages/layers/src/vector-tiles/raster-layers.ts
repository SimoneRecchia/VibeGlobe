// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Raster, hillshade, color-relief and heatmap style layers (F445, ADR 0133): textured tile squares that follow the globe, the morph
 * and the terrain like the background. Raster and raster-dem tiles are requested through the transport and decoded on
 * the main thread (an image decode, then its pixels); hillshade shading and heatmap densities are drawn into images on
 * the CPU (`raster-images.ts`). A tile not loaded yet is drawn by its nearest ready ancestor, clipped to its square.
 */
import type { AbortHandle, TileTransport, TransportResult } from '@vibeglobe/core';
import type { TileGrounds } from './drape.js';
import { tileOrigin } from './globe-vertices.js';
import type { Bucket } from './layout-tile.js';
import { colorReliefImage, decodeDem, heatmapImage, hillshadeImage, type HeatmapPoint } from './raster-images.js';
import type { StyleLayer } from './style-layer.js';
import { tileUrl, type SourceInfo } from './style-sources.js';
import { backgroundBucket, meshGeometry } from './tile-meshes.js';
import { clipOf, tileKey, tilesToDraw, tilesToRequest, type TileId } from './tile-pyramid.js';
import { zoomBracket } from './vector-paint.js';
import type { RasterImage, VectorDraw, VectorLayerDraws, VectorMesh, VectorTileTarget } from './vector-target.js';

/** A tile that failed on the way is requested again after this long. */
const RETRY_MS = 5_000;

/** What raster layers need from the vector tile layer. */
export interface RasterLayerContext {
  readonly target: VectorTileTarget;
  readonly transport: TileTransport;
  readonly sources: ReadonlyMap<string, SourceInfo | undefined>;
  readonly grounds: TileGrounds;
  /** Asks for a frame (a tile arrived). */
  readonly onReady: () => void;
  /** The laid-out buckets of a vector source's tile, for heatmaps. */
  readonly buckets: (sourceId: string, tile: TileId) => readonly Bucket[] | undefined;
  /** Decodes image bytes to RGBA pixels; `createImageBitmap` and a canvas by default. */
  readonly decode?: (bytes: ArrayBuffer) => Promise<RasterImage | undefined>;
}

const MAX_IN_FLIGHT = 6;
const MAX_IMAGES = 128;
/** Raster meshes kept (each holds its texture on the GPU). */
const MAX_MESHES = 64;
/** Heatmap images are made again when the zoom moves by this much (their radius is in screen pixels). */
const HEATMAP_ZOOM_STEP = 0.25;

interface ImageEntry {
  state: 'loading' | 'ready' | 'missing';
  image?: RasterImage;
  heights?: Float32Array;
  abort?: AbortHandle | undefined;
  usedAtFrame: number;
}

interface MeshEntry {
  readonly mesh: VectorMesh;
  usedAtFrame: number;
  /** The terrain version its ground heights follow, refreshed in place (KB-242). */
  groundVersion: number;
  readonly tileXY: Float32Array;
  readonly ground: Float32Array;
}

async function decodeImage(bytes: ArrayBuffer): Promise<RasterImage | undefined> {
  const bitmap = await createImageBitmap(new Blob([bytes]));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (context === null) return undefined;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  return { width: canvas.width, height: canvas.height, data };
}

/** The raster-like layers of one vector tile layer. */
export class RasterLayers {
  private readonly images = new Map<string, ImageEntry>();
  private readonly meshes = new Map<string, MeshEntry>();
  private inFlight = 0;
  private frame = 0;

  constructor(private readonly context: RasterLayerContext) {}

  /** Starts a frame. */
  beginFrame(): void {
    this.frame++;
  }

  /** Tiles requested and not arrived yet (tests wait for 0). */
  loading(): number {
    return [...this.images.values()].filter((e) => e.state === 'loading').length;
  }

  /**
   * The draws of a raster, hillshade or heatmap layer over the view's target tiles (`targets`), or, for heatmaps, over
   * the draws of their vector source (`vectorDraws`).
   */
  draws(
    layer: StyleLayer,
    opacity: number,
    zoom: number,
    paintVersion: number,
    targets: readonly TileId[],
    vectorDraws: readonly { readonly tile: TileId; readonly clip: readonly [number, number, number, number] }[],
  ): VectorLayerDraws | undefined {
    const source = layer.source === undefined ? undefined : this.context.sources.get(layer.source);
    if (source === undefined) return undefined;
    const { zoomA, t } = zoomBracket(zoom);
    const list: VectorDraw[] = [];
    if (layer.type === 'heatmap') {
      for (const d of vectorDraws) {
        const mesh = this.heatmapMesh(layer, source, d.tile, zoom, paintVersion);
        if (mesh !== undefined) list.push({ mesh, clip: [...d.clip], pxPerUnit: 1 });
      }
    } else if (source.raster !== undefined) {
      const sourceId = layer.source ?? '';
      const ready = (tile: TileId) => this.images.get(`${sourceId}|${tileKey(tile)}`)?.state === 'ready';
      for (const tile of tilesToRequest(targets, source.coverage)) this.request(sourceId, source, tile);
      for (const d of tilesToDraw(targets, source.coverage, ready)) {
        const mesh = this.rasterMesh(layer, sourceId, d.tile, zoomA, paintVersion);
        if (mesh !== undefined) list.push({ mesh, clip: clipOf(d.tile, d.target), pxPerUnit: 1 });
      }
    }
    return { layerId: layer.id, kind: 'raster', opacity, zoomT: t, draws: list };
  }

  /** Frees meshes and images no frame used lately. */
  evict(): void {
    if (this.meshes.size > MAX_MESHES)
      for (const [key, entry] of [...this.meshes].sort((a, b) => a[1].usedAtFrame - b[1].usedAtFrame)) {
        if (this.meshes.size <= MAX_MESHES || entry.usedAtFrame === this.frame) break;
        entry.mesh.dispose();
        this.meshes.delete(key);
      }
    if (this.images.size > MAX_IMAGES)
      for (const [key, entry] of [...this.images].sort((a, b) => a[1].usedAtFrame - b[1].usedAtFrame)) {
        if (this.images.size <= MAX_IMAGES || entry.usedAtFrame === this.frame) break;
        entry.abort?.();
        this.images.delete(key);
      }
  }

  /** Frees everything. */
  dispose(): void {
    for (const entry of this.meshes.values()) entry.mesh.dispose();
    this.meshes.clear();
    for (const entry of this.images.values()) entry.abort?.();
    this.images.clear();
  }

  private request(sourceId: string, source: SourceInfo, tile: TileId): void {
    const key = `${sourceId}|${tileKey(tile)}`;
    const existing = this.images.get(key);
    if (existing !== undefined) {
      existing.usedAtFrame = this.frame;
      return;
    }
    if (this.inFlight >= MAX_IN_FLIGHT) return;
    const entry: ImageEntry = { state: 'loading', usedAtFrame: this.frame };
    this.images.set(key, entry);
    this.inFlight++;
    const url = tileUrl(source, tile);
    const timeouts = { firstByteMs: 10_000, totalMs: 30_000 };
    entry.abort = this.context.transport.start({ url, hostIndex: 0 }, timeouts, (result: TransportResult) => {
      this.inFlight--;
      entry.abort = undefined;
      if (result.kind !== 'ok' || result.contentType.startsWith('text/html')) {
        entry.state = 'missing';
        // A failure on the way (a timeout, a reset, 429 or 5xx) is asked for again later; no data stays missing.
        if (result.kind !== 'ok' && !(result.kind === 'status' && [204, 404, 410].includes(result.status)))
          setTimeout(() => {
            if (this.images.get(key) !== entry) return;
            this.images.delete(key);
            this.context.onReady();
          }, RETRY_MS);
        return;
      }
      void (this.context.decode ?? decodeImage)(result.bytes)
        .catch(() => undefined)
        .then((image) => {
          if (image === undefined) entry.state = 'missing';
          else {
            entry.state = 'ready';
            entry.image = image;
            const encoding = source.raster?.encoding;
            if (encoding !== undefined) entry.heights = decodeDem(image.data, encoding);
          }
          this.context.onReady();
        });
    });
  }

  /** The mesh of `key`, made from `image` when new. */
  private mesh(
    key: string,
    tile: TileId,
    image: RasterImage | undefined,
    paint: { color: number[]; params: number[] }[],
  ): VectorMesh | undefined {
    const existing = this.meshes.get(key);
    if (existing !== undefined) {
      existing.usedAtFrame = this.frame;
      const grounds = this.context.grounds;
      if (existing.groundVersion !== grounds.version && grounds.active && grounds.canDrape) {
        existing.groundVersion = grounds.version;
        existing.mesh.update({ ground: grounds.heights(tile, existing.tileXY, existing.ground) });
      }
      return existing.mesh;
    }
    if (image === undefined) return undefined;
    const geometry = meshGeometry('fill', backgroundBucket(tile, key), tileOrigin(tile));
    if (geometry === undefined) return undefined;
    const n = geometry.featureIndex.length;
    const fill = (values: number[]) => {
      const out = new Float32Array(n * 4);
      for (let v = 0; v < n; v++) out.set(values, v * 4);
      return out;
    };
    const ground = this.context.grounds.heights(tile, geometry.data.tile, geometry.data.ground);
    const mesh = this.context.target.createMesh({
      ...geometry.data,
      kind: 'raster',
      colorA: fill(paint[0]?.color ?? [0, 0, 0, 1]),
      colorB: fill(paint[1]?.color ?? [0, 0, 0, 1]),
      paramsA: fill(paint[0]?.params ?? [0, 1, 0, 0]),
      paramsB: fill(paint[1]?.params ?? [0, 1, 0, 0]),
      ground,
      image,
    });
    this.meshes.set(key, {
      mesh,
      usedAtFrame: this.frame,
      groundVersion: this.context.grounds.version,
      tileXY: geometry.data.tile,
      ground: geometry.data.ground,
    });
    return mesh;
  }

  private rasterMesh(layer: StyleLayer, sourceId: string, tile: TileId, zoomA: number, paintVersion: number) {
    const entry = this.images.get(`${sourceId}|${tileKey(tile)}`);
    if (entry?.image === undefined) return undefined;
    entry.usedAtFrame = this.frame;
    // The terrain refreshes a kept mesh's ground in place: neither its image nor its texture is made again (KB-242).
    const version = `${layer.id}|${tileKey(tile)}|${paintVersion}`;
    if (layer.type === 'hillshade') {
      if (entry.heights === undefined) return undefined;
      const key = `hillshade|${version}`;
      const image = this.kept(key) ? undefined : hillshadeImage(entry.heights, entry.image.width, tile, layer, tile.z);
      return this.mesh(key, tile, image, [{ color: [0, 0, 0, 1], params: [0, 1, 0, 0] }]);
    }
    if (layer.type === 'color-relief') {
      if (entry.heights === undefined) return undefined;
      const key = `color-relief|${version}|${zoomA}`;
      const image = this.kept(key) ? undefined : colorReliefImage(entry.heights, entry.image.width, layer, tile.z);
      const paint = [zoomA, zoomA + 1].map((z) => ({
        color: [0, 0, 0, Number(layer.paint('color-relief-opacity', z) ?? 1)],
        params: [0, 1, 0, 0],
      }));
      return this.mesh(key, tile, image, paint);
    }
    const paint = [zoomA, zoomA + 1].map((z) => {
      const p = (name: string, fallback: number) => Number(layer.paint(name, z) ?? fallback);
      return {
        color: [0, 0, 0, p('raster-opacity', 1)],
        params: [
          p('raster-brightness-min', 0),
          p('raster-brightness-max', 1),
          p('raster-saturation', 0),
          p('raster-contrast', 0),
        ],
      };
    });
    return this.mesh(`raster|${version}|${zoomA}`, tile, entry.image, paint);
  }

  /**
   * A heatmap tile's mesh. Its kernels reach into the neighboring tiles: the points of the tile and of its eight
   * neighbors at the same zoom (each tile lays out only the points of its own square) all count, so no seam shows; the
   * image is made again as neighbors arrive.
   */
  private heatmapMesh(layer: StyleLayer, source: SourceInfo, tile: TileId, zoom: number, paintVersion: number) {
    if (source.raster !== undefined) return undefined;
    const n = 2 ** tile.z;
    const parts: { bucket: Bucket; dx: number; dy: number }[] = [];
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const y = tile.y + dy;
        if (y < 0 || y >= n) continue;
        const neighbor = { z: tile.z, x: (tile.x + dx + n) % n, y };
        const bucket = this.context.buckets(layer.source ?? '', neighbor)?.find((b) => b.layerId === layer.id);
        if (bucket?.geometry !== undefined) parts.push({ bucket, dx, dy });
      }
    if (!parts.some((p) => p.dx === 0 && p.dy === 0)) return undefined;
    const zoomQ = Math.round(zoom / HEATMAP_ZOOM_STEP) * HEATMAP_ZOOM_STEP;
    const key = `heatmap|${layer.id}|${tileKey(tile)}|${zoomQ}|${paintVersion}|${parts.length}`;
    const image = this.kept(key) ? undefined : this.heatmap(layer, parts, tile, zoomQ);
    const opacity = Number(layer.paint('heatmap-opacity', zoom) ?? 1);
    const paint = { color: [0, 0, 0, opacity], params: [0, 1, 0, 0] };
    return this.mesh(key, tile, image, [paint, paint]);
  }

  /** Whether the mesh of `key` exists (then marked used): its image need not be made again. */
  private kept(key: string): boolean {
    const entry = this.meshes.get(key);
    if (entry !== undefined) entry.usedAtFrame = this.frame;
    return entry !== undefined;
  }

  private heatmap(
    layer: StyleLayer,
    parts: readonly { bucket: Bucket; dx: number; dy: number }[],
    tile: TileId,
    zoom: number,
  ): RasterImage {
    const points: HeatmapPoint[] = [];
    for (const { bucket, dx, dy } of parts) {
      const positions = bucket.geometry?.positions ?? new Float32Array(0);
      const index = bucket.geometry?.featureIndex;
      for (let i = 0; i < positions.length / 2; i++) {
        const weight = Number(layer.paint('heatmap-weight', zoom, bucket.features[index?.[i] ?? 0]) ?? 1);
        points.push({ x: (positions[i * 2] ?? 0) + dx * 4096, y: (positions[i * 2 + 1] ?? 0) + dy * 4096, weight });
      }
    }
    return heatmapImage(points, 512 * 2 ** (zoom - tile.z), layer, zoom);
  }
}
