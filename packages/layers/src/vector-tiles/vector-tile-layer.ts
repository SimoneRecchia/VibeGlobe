/**
 * Vector tiles on the globe (M13, ADR 0131): `addVectorTiles` loads a MapLibre style without edits (F444) and draws
 * it through a render extension (`Globe.addRenderExtension`). Each frame it derives the vector tiles of the view from
 * the surface's tiles, requests them through the engine's request pool, lays them out on its workers, draws every
 * target square with its own tile or its nearest ready ancestor (overzoom past `maxzoom` and stand-ins while loading,
 * F442), in style-layer order with fades at zoom limits and on visibility changes (F447), with paint mixed between
 * integer zooms (F440). Runtime style changes re-evaluate paint in place or lay out again from the kept bytes (F450).
 */
import type { FrameView, Globe, RenderExtensionContext, ScreenPoint } from '@vibeglobe/core';
import type { VectorTileLayer, VectorTilesOptions } from './vector-tile-api.js';
import { VectorInteraction, type VectorFeatureEvent } from './vector-interaction.js';
import { pickVectorFeatures, type DrawnTile, type PickedVectorFeature } from './vector-picking.js';
import { fetchTransport } from '@vibeglobe/sources';
import { GlyphSource } from './glyph-source.js';
import { LabelPlacer, type LabelSource, type PlacedLabel } from './label-placer.js';
import { LayerFader } from './layer-fader.js';
import { tileOrigin } from './globe-vertices.js';
import { VectorTileLoader } from './tile-loader.js';
import { backgroundBucket, meshGeometry } from './tile-meshes.js';
import { retainedTiles, tileKey, tilesToDraw, tilesToRequest, type TileId } from './tile-pyramid.js';
import { meshKindOf, meshPaint, zoomBracket, type MeshPaint } from './vector-paint.js';
import { VectorStyle, changeNeedsRelayout, type StyleChange } from './vector-style.js';
import { json, resolveSource, tileUrl, type SourceInfo } from './style-sources.js';
import type { StyleLayer } from './style-layer.js';
import type { VectorLayerDraws, VectorMesh, VectorTileTarget } from './vector-target.js';

export type { VectorTileLayer, VectorTilesOptions } from './vector-tile-api.js';
import { sampledTiles, viewTargets } from './view-tiles.js';
import { BUCKET_EXTENT, type Bucket } from './layout-tile.js';

/** A source of the style, resolved (TileJSON read). */
interface ResolvedSource extends SourceInfo {
  readonly id: string;
  readonly loader: VectorTileLoader;
}

interface SourceDraw {
  readonly tile: TileId;
  readonly clip: [number, number, number, number];
}

interface TileMesh {
  readonly mesh: VectorMesh;
  readonly featureIndex: Uint32Array;
  readonly bucket: Bucket;
  paint: MeshPaint;
  paintKey: string;
}

/** Logs a problem the way the engine's log does (until extensions can use it: hook request D (1)). */
function warn(text: string): void {
  (globalThis as { console?: { warn(text: string): void } }).console?.warn(`[vibeglobe] vector tiles: ${text}`);
}

/** Loads a style and draws it on the globe; resolves once the style and its sources are read. Call after `ready`. */
export async function addVectorTiles(globe: Globe, options: VectorTilesOptions): Promise<VectorTileLayer> {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const base =
    typeof options.style === 'string'
      ? new URL(options.style, globalThis.location?.href).href
      : globalThis.location?.href;
  const styleJson = typeof options.style === 'string' ? await json(base ?? options.style, fetchImpl) : options.style;
  const style = VectorStyle.load(styleJson);
  for (const problem of style.problems) warn(`style ${problem.path}: ${problem.message}`);
  const resolved = new Map<string, SourceInfo | undefined>();
  for (const [id, source] of Object.entries(style.sources)) {
    try {
      resolved.set(id, await resolveSource(source, base, fetchImpl));
    } catch (error) {
      style.problems.push({ path: `sources.${id}`, message: String(error) });
      warn(`style source ${id}: ${String(error)}`);
    }
  }
  return new Runtime(globe, options, style, resolved).start();
}

/** One layer's runtime. */
class Runtime implements VectorTileLayer {
  private readonly sources = new Map<string, ResolvedSource>();
  private readonly meshes = new Map<string, TileMesh>();
  private readonly fader = new LayerFader();
  private readonly featureStates = new Map<string, Record<string, unknown>>();
  private target: VectorTileTarget | undefined;
  private removeExtension: (() => void) | undefined;
  private layoutVersion = 1;
  private paintVersion = 1;
  private targets: TileId[] = [];
  private lastDrawn: { tile: string; target: string; standIn: boolean }[] = [];
  private unsubscribe: (() => void) | undefined;
  private placer: LabelPlacer | undefined;
  private drawnTilesWithBuckets: DrawnTile[] = [];
  private readonly interaction = new VectorInteraction(
    (point) => this.queryRenderedFeatures(point),
    (feature, state) => {
      if (feature.id !== undefined) this.setFeatureState({ source: feature.source, id: feature.id }, state);
    },
  );
  private detachPointer: (() => void) | undefined;

  constructor(
    private readonly globe: Globe,
    private readonly options: VectorTilesOptions,
    readonly style: VectorStyle,
    private readonly resolved: ReadonlyMap<string, SourceInfo | undefined>,
  ) {}

  start(): this {
    if (this.options.element !== undefined) this.detachPointer = this.interaction.attach(this.options.element);
    this.removeExtension = this.globe.addRenderExtension((context) => this.extension(context));
    this.unsubscribe = this.style.onChange((change) => this.changed(change));
    return this;
  }

  setFeatureState(
    feature: { readonly source: string; readonly id: number | string },
    state: Record<string, unknown>,
  ): void {
    const key = `${feature.source}|${feature.id}`;
    this.featureStates.set(key, { ...this.featureStates.get(key), ...state });
    this.paintVersion++;
    this.globe.requestRender();
  }

  queryRenderedFeatures(point: ScreenPoint): PickedVectorFeature[] {
    return pickVectorFeatures(
      {
        screenToGeo: (p) => this.globe.screenToGeo(p),
        geoToScreen: (p) => this.globe.geoToScreen(p),
        zoom: this.globe.camera.zoom,
        layers: this.style.layers,
        drawn: this.drawnTilesWithBuckets,
        labels: this.placedLabels(),
      },
      point,
    );
  }

  on(listener: (event: VectorFeatureEvent) => void): () => void {
    return this.interaction.on(listener);
  }

  placedLabels(): readonly PlacedLabel[] {
    return this.placer?.placed() ?? [];
  }

  requestLog(source?: string): readonly string[] {
    if (source !== undefined) return this.sources.get(source)?.loader.requestLog ?? [];
    return [...this.sources.values()].flatMap((s) => s.loader.requestLog);
  }

  drawnTiles(): readonly { readonly tile: string; readonly target: string; readonly standIn: boolean }[] {
    return this.lastDrawn;
  }

  remove(): void {
    this.detachPointer?.();
    this.unsubscribe?.();
    this.removeExtension?.();
    this.removeExtension = undefined;
  }

  private extension(context: RenderExtensionContext) {
    const target = this.options.target(context.renderer);
    this.target = target;
    const transport = this.options.transport ?? fetchTransport();
    const fetchImpl = this.options.fetch ?? ((input, init) => fetch(input, init));
    const glyphs = new GlyphSource(
      this.style.glyphs,
      fetchImpl,
      () => context.requestRender(),
      target,
      this.options.localFontFamily,
    );
    void glyphs.loadSprite(this.style.sprite, globalThis.devicePixelRatio ?? 1);
    this.placer = new LabelPlacer(this.globe, glyphs, target.atlas, (source, id) =>
      this.featureStates.get(`${source}|${id}`),
    );
    for (const [id, source] of this.resolved) {
      if (source === undefined) continue;
      const loader = new VectorTileLoader({
        transport,
        network: context.network,
        workers: context.workers,
        onReady: () => context.requestRender(),
      });
      this.sources.set(id, { id, ...source, loader });
    }
    return {
      frame: (view: FrameView) => this.frame(view, context),
      dispose: () => {
        for (const source of this.sources.values()) source.loader.dispose();
        this.sources.clear();
        this.meshes.clear();
        target.dispose();
        this.target = undefined;
      },
    };
  }

  private changed(change: StyleChange): void {
    if (changeNeedsRelayout(change)) this.layoutVersion++;
    else this.paintVersion++;
    if (change.kind === 'order' && this.style.layer(change.layerId) === undefined)
      this.target?.removeLayer(change.layerId);
    this.globe.requestRender();
  }

  private frame(view: FrameView, context: RenderExtensionContext): void {
    const target = this.target;
    if (target === undefined) return;
    const zoom = this.globe.camera.zoom;
    const draws = this.sourceDraws(view);
    const fades = this.fader.update(this.globe.timeMs, zoom, this.style.layers);
    let animating = false;
    const layerDraws: VectorLayerDraws[] = [];
    for (const layer of this.style.layers) {
      const opacity = fades.get(layer.id) ?? 0;
      if (opacity > 0 && opacity < 1) animating = true;
      const drawn = opacity > 0 ? this.layerDraws(layer, opacity, zoom, draws) : undefined;
      if (drawn !== undefined) layerDraws.push(drawn);
    }
    this.evictMeshes();
    const labels = this.placer?.frame(this.labelSources(fades, draws), view, zoom, this.globe.timeMs);
    target.setLabels(labels?.quads);
    target.draw(layerDraws, view);
    if (animating || labels?.animating === true) context.requestRender();
  }

  /** The symbol buckets of the drawn tiles, with their layer's fade. */
  private labelSources(
    fades: ReadonlyMap<string, number>,
    draws: ReadonlyMap<string, readonly SourceDraw[]>,
  ): LabelSource[] {
    const out: LabelSource[] = [];
    this.style.layers.forEach((layer, layerIndex) => {
      const opacity = fades.get(layer.id) ?? 0;
      const source = layer.source === undefined ? undefined : this.sources.get(layer.source);
      if (layer.type !== 'symbol' || opacity <= 0 || source === undefined) return;
      for (const d of draws.get(source.id) ?? []) {
        const loaded = source.loader.get(d.tile);
        const bucket = loaded?.buckets.find((b) => b.layerId === layer.id);
        if (loaded === undefined || bucket === undefined) continue;
        out.push({ layer, layerIndex, opacity, tile: d.tile, clip: d.clip, bucket, version: loaded.version });
      }
    });
    return out;
  }

  /** Per source: the tiles to draw for the view's targets (requesting what is missing), each with its clip. */
  private sourceDraws(view: FrameView): Map<string, readonly SourceDraw[]> {
    const detail = sampledTiles(this.globe, view.widthPx, view.heightPx);
    const targets = viewTargets(this.globe.surfaceTiles(), 24, detail);
    this.targets = targets;
    const draws = new Map<string, readonly SourceDraw[]>();
    this.lastDrawn = [];
    this.drawnTilesWithBuckets = [];
    for (const source of this.sources.values()) {
      const layers = this.style.layers.filter((l) => l.source === source.id).map((l) => l.json);
      source.loader.setLayers(layers, this.layoutVersion);
      const isReady = (tile: TileId) => source.loader.get(tile) !== undefined;
      const sourceDraws = tilesToDraw(targets, source.coverage, isReady);
      const wanted = tilesToRequest(targets, source.coverage).map((tile, i) => ({
        tile,
        url: tileUrl(source, tile),
        priority: i,
      }));
      source.loader.update(wanted, retainedTiles(sourceDraws));
      draws.set(
        source.id,
        sourceDraws.map((d) => ({ tile: d.tile, clip: clipOf(d.tile, d.target) })),
      );
      for (const d of sourceDraws) {
        this.lastDrawn.push({ tile: tileKey(d.tile), target: tileKey(d.target), standIn: d.standIn });
        const buckets = source.loader.get(d.tile)?.buckets ?? [];
        this.drawnTilesWithBuckets.push({ source: source.id, tile: d.tile, clip: clipOf(d.tile, d.target), buckets });
      }
    }
    return draws;
  }

  /** One style layer's draws, or undefined when it draws nothing. */
  private layerDraws(
    layer: StyleLayer,
    opacity: number,
    zoom: number,
    draws: ReadonlyMap<string, readonly SourceDraw[]>,
  ): VectorLayerDraws | undefined {
    const kind = meshKindOf(layer.type);
    const source = layer.source === undefined ? undefined : this.sources.get(layer.source);
    if (kind === undefined || (source === undefined && layer.type !== 'background')) return undefined;
    const { zoomA, t } = zoomBracket(zoom);
    const list = [];
    const sourceDraws =
      source === undefined ? this.targets.map((tile) => ({ tile, clip: clipOf(tile, tile) })) : draws.get(source.id);
    for (const d of sourceDraws ?? []) {
      const mesh = this.meshFor(source, d.tile, layer, zoomA);
      if (mesh === undefined) continue;
      list.push({ mesh: mesh.mesh, clip: d.clip, pxPerUnit: (512 * 2 ** (zoom - d.tile.z)) / BUCKET_EXTENT });
    }
    const dash = layer.type === 'line' ? layer.paint('line-dasharray', zoom) : undefined;
    const extrusionOpacity =
      layer.type === 'fill-extrusion' ? Number(layer.paint('fill-extrusion-opacity', zoom) ?? 1) : 1;
    return {
      layerId: layer.id,
      kind,
      opacity: opacity * extrusionOpacity,
      zoomT: t,
      ...(Array.isArray(dash) ? { dash: dash as number[] } : {}),
      ...(layer.type === 'fill-extrusion' ? { solid: extrusionOpacity >= 1 } : {}),
      draws: list,
    };
  }

  /** The mesh of a tile's bucket for a layer, built on first use and repainted when paint or the zoom pair changed. */
  private meshFor(
    source: ResolvedSource | undefined,
    tile: TileId,
    layer: StyleLayer,
    zoomA: number,
  ): TileMesh | undefined {
    const loaded = source?.loader.get(tile);
    const target = this.target;
    if ((source !== undefined && loaded === undefined) || target === undefined) return undefined;
    const key = `${source?.id ?? ''}|${loaded?.key ?? tileKey(tile)}|${layer.id}|${loaded?.version ?? 0}`;
    const paintKey = `${zoomA}|${this.paintVersion}`;
    let entry = this.meshes.get(key);
    if (entry === undefined) {
      const bucket =
        loaded === undefined ? backgroundBucket(tile, layer.id) : loaded.buckets.find((b) => b.layerId === layer.id);
      const kind = meshKindOf(layer.type);
      if (bucket === undefined || kind === undefined) return undefined;
      const geometry = meshGeometry(kind, bucket, tileOrigin(tile));
      if (geometry === undefined) return undefined;
      const paint = meshPaint(layer, bucket, geometry.featureIndex, zoomA, (f) => this.stateOf(source?.id ?? '', f.id));
      const mesh = target.createMesh({ ...geometry.data, ...paint });
      entry = { mesh, featureIndex: geometry.featureIndex, bucket, paint, paintKey };
      this.meshes.set(key, entry);
    } else if (entry.paintKey !== paintKey) {
      meshPaint(
        layer,
        entry.bucket,
        entry.featureIndex,
        zoomA,
        (f) => this.stateOf(source?.id ?? '', f.id),
        entry.paint,
      );
      entry.mesh.update(entry.paint);
      entry.paintKey = paintKey;
    }
    (entry as { usedAt?: number }).usedAt = this.globe.frameNumber;
    return entry;
  }

  private stateOf(source: string, id: number | undefined): Record<string, unknown> | undefined {
    return id === undefined ? undefined : this.featureStates.get(`${source}|${id}`);
  }

  /** Frees meshes not drawn for a while (their tile left the cache, or an older layout version). */
  private evictMeshes(): void {
    const now = this.globe.frameNumber;
    for (const [key, entry] of this.meshes) {
      const usedAt = (entry as { usedAt?: number }).usedAt ?? now;
      if (now - usedAt > 120) {
        entry.mesh.dispose();
        this.meshes.delete(key);
      }
    }
  }
}

/** The square of `target` in the units of `tile` (its ancestor or itself). */
function clipOf(tile: TileId, target: TileId): [number, number, number, number] {
  const scale = 2 ** (target.z - tile.z);
  const size = BUCKET_EXTENT / scale;
  const x = (target.x - tile.x * scale) * size;
  const y = (target.y - tile.y * scale) * size;
  return [x, y, x + size, y + size];
}
