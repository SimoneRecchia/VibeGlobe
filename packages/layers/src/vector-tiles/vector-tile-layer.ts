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
import { TileGrounds } from './drape.js';
import { GlyphSource } from './glyph-source.js';
import { LabelPlacer, type LabelSource, type PlacedLabel } from './label-placer.js';
import { LayerFader } from './layer-fader.js';
import { localizedTextField } from './osm.js';
import { VectorTileLoader } from './tile-loader.js';
import {
  ancestorAt,
  clipOf,
  retainedTiles,
  tileKey,
  tilesToDraw,
  tilesToRequest,
  type TileId,
} from './tile-pyramid.js';
import { meshKindOf, zoomBracket, type PaintPart } from './vector-paint.js';
import { TileMeshCache } from './tile-mesh-cache.js';
import { VectorStyle, changeNeedsRelayout, type StyleChange } from './vector-style.js';
import { tileUrl, transformedTransport, type SourceInfo } from './style-sources.js';
import { geojsonTransport } from './geojson-tiles.js';
import { RasterLayers } from './raster-layers.js';
import type { StyleLayer } from './style-layer.js';
import type { VectorLayerDraws, VectorTileTarget } from './vector-target.js';
import { sampledTiles, viewTargets } from './view-tiles.js';
import { BUCKET_EXTENT } from './layout-tile.js';

export type { VectorTileLayer, VectorTilesOptions } from './vector-tile-api.js';

/** Style layer types drawn as textured tile squares (F445). */
const RASTER_TYPES = new Set(['raster', 'hillshade', 'heatmap']);

/** A source of the style, resolved (TileJSON read). */
interface ResolvedSource extends SourceInfo {
  readonly id: string;
  readonly loader: VectorTileLoader;
}

interface SourceDraw {
  readonly tile: TileId;
  readonly clip: [number, number, number, number];
}

/** Starts the runtime of a loaded style on a globe: its render extension, and pointer events with `element`. */
export function startVectorTileLayer(
  globe: Globe,
  options: VectorTilesOptions,
  style: VectorStyle,
  resolved: ReadonlyMap<string, SourceInfo | undefined>,
): VectorTileLayer {
  return new Runtime(globe, options, style, resolved).start();
}

/** One layer's runtime. */
class Runtime implements VectorTileLayer {
  private readonly sources = new Map<string, ResolvedSource>();
  private meshes: TileMeshCache | undefined;
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
  private readonly grounds: TileGrounds;
  private rasters: RasterLayers | undefined;
  private msLastFrame = 0;
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
  ) {
    this.grounds = new TileGrounds(globe);
  }

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

  setLanguage(language: string): void {
    for (const layer of this.style.layers) {
      if (layer.type !== 'symbol' || !JSON.stringify(layer.json.layout?.['text-field'] ?? '').includes('name'))
        continue;
      this.style.setLayoutProperty(layer.id, 'text-field', localizedTextField(language));
    }
  }

  on(listener: (event: VectorFeatureEvent) => void): () => void {
    return this.interaction.on(listener);
  }

  placedLabels(): readonly PlacedLabel[] {
    return this.placer?.placed() ?? [];
  }

  loadingTiles(): number {
    let n = 0;
    for (const source of this.sources.values()) n += source.loader.loading;
    return n + (this.rasters?.loading() ?? 0);
  }

  requestLog(source?: string): readonly string[] {
    if (source !== undefined) return this.sources.get(source)?.loader.requestLog ?? [];
    return [...this.sources.values()].flatMap((s) => s.loader.requestLog);
  }

  frameTimeMs(): number {
    return this.msLastFrame;
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
    const transport = transformedTransport(this.options.transport ?? fetchTransport(), this.options.transformUrl);
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
      if (source === undefined || source.raster !== undefined) continue;
      const loader = new VectorTileLoader({
        // GeoJSON tiles are cut locally: no request pool.
        transport: source.geojson === undefined ? transport : geojsonTransport(source.geojson, source.lineMetrics),
        network: source.geojson === undefined ? context.network : undefined,
        workers: context.workers,
        onReady: () => context.requestRender(),
      });
      this.sources.set(id, { id, ...source, loader });
    }
    this.meshes = new TileMeshCache(
      () => this.target,
      this.grounds,
      (source, f) => this.stateOf(source, f.id),
      (name) => {
        const image = glyphs.icon(name);
        const key = `icon|${name}|${image?.icon.pixelRatio ?? 1}`;
        const rect =
          image && (target.atlas.get(key) ?? target.atlas.addRgba(key, image.pixels, image.width, image.height));
        return rect && image ? { ...rect, pixelRatio: image.icon.pixelRatio } : undefined;
      },
    );
    this.rasters = new RasterLayers({
      target,
      transport,
      sources: this.resolved,
      grounds: this.grounds,
      onReady: () => context.requestRender(),
      buckets: (id, tile) => this.sources.get(id)?.loader.get(tile)?.buckets,
    });
    return {
      frame: (view: FrameView) => this.frame(view, context),
      dispose: () => {
        this.rasters?.dispose();
        for (const source of this.sources.values()) source.loader.dispose();
        this.sources.clear();
        this.meshes?.clear();
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
    const start = performance.now();
    this.drawFrame(view, context);
    this.msLastFrame = performance.now() - start;
  }

  private drawFrame(view: FrameView, context: RenderExtensionContext): void {
    const target = this.target;
    if (target === undefined) return;
    const zoom = this.globe.camera.zoom;
    const draws = this.sourceDraws(view);
    this.grounds.frame();
    this.rasters?.beginFrame();
    if (this.meshes) this.meshes.drapePending = false;
    const fades = this.fader.update(this.globe.timeMs, zoom, this.style.layers);
    let animating = false;
    const layerDraws: VectorLayerDraws[] = [];
    for (const layer of this.style.layers) {
      const opacity = fades.get(layer.id) ?? 0;
      if (opacity > 0 && opacity < 1) animating = true;
      if (opacity <= 0) continue;
      const drawn = this.layerDraws(layer, opacity, zoom, draws);
      if (drawn !== undefined) layerDraws.push(drawn);
      // A fill's outline draws right over it (F445).
      if (layer.type === 'fill' && layer.json.paint?.['fill-outline-color'] !== undefined) {
        const outline = this.layerDraws(layer, opacity, zoom, draws, 'outline');
        if (outline !== undefined) layerDraws.push(outline);
      }
    }
    this.meshes?.evict(this.globe.frameNumber);
    this.rasters?.evict();
    const labels = this.placer?.frame(this.labelSources(fades, draws), view, zoom, this.globe.timeMs);
    target.setLabels(labels?.quads);
    target.draw(layerDraws, view);
    if (animating || this.meshes?.drapePending === true || labels?.animating === true) context.requestRender();
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
      const wanted = wantedTiles(source, targets).map((tile, i) => ({ tile, url: tileUrl(source, tile), priority: i }));
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
    part?: PaintPart,
  ): VectorLayerDraws | undefined {
    if (RASTER_TYPES.has(layer.type))
      return this.rasters?.draws(
        layer,
        opacity,
        zoom,
        this.paintVersion,
        this.targets,
        draws.get(layer.source ?? '') ?? [],
      );
    const kind = meshKindOf(part === 'outline' ? 'fill-outline' : layer.type);
    const source = layer.source === undefined ? undefined : this.sources.get(layer.source);
    if (kind === undefined || (source === undefined && layer.type !== 'background')) return undefined;
    const { zoomA, t } = zoomBracket(zoom);
    const list = [];
    const sourceDraws =
      source === undefined ? this.targets.map((tile) => ({ tile, clip: clipOf(tile, tile) })) : draws.get(source.id);
    for (const d of sourceDraws ?? []) {
      const from = { sourceId: source?.id ?? '', loaded: source?.loader.get(d.tile), tile: d.tile };
      if (source !== undefined && from.loaded === undefined) continue;
      const mesh = this.meshes?.get(from, layer, zoomA, this.paintVersion, this.globe.frameNumber, part);
      if (mesh === undefined) continue;
      list.push({ mesh, clip: d.clip, pxPerUnit: (512 * 2 ** (zoom - d.tile.z)) / BUCKET_EXTENT });
    }
    const dash = layer.type === 'line' ? layer.paint('line-dasharray', zoom) : undefined;
    const extrusionOpacity =
      layer.type === 'fill-extrusion' ? Number(layer.paint('fill-extrusion-opacity', zoom) ?? 1) : 1;
    return {
      // The outline draws in a group of its own, right after its fill's.
      layerId: part === undefined ? layer.id : `${layer.id}\u0000${part}`,
      kind,
      opacity: opacity * extrusionOpacity,
      zoomT: t,
      ...(Array.isArray(dash) ? { dash: dash as number[] } : {}),
      ...(layer.type === 'fill-extrusion' ? { solid: extrusionOpacity >= 1, heightScale: opacity } : {}),
      draws: list,
    };
  }

  private stateOf(source: string, id: number | undefined): Record<string, unknown> | undefined {
    return id === undefined ? undefined : this.featureStates.get(`${source}|${id}`);
  }
}

/**
 * The tiles to request for the targets: their source tiles, and for a tile the source does not have (404), its nearest
 * ancestor the source may have, so a stand-in exists (F442).
 */
function wantedTiles(source: ResolvedSource, targets: readonly TileId[]): TileId[] {
  const out = new Map<string, TileId>();
  for (const tile of tilesToRequest(targets, source.coverage)) {
    let t: TileId | undefined = tile;
    while (t !== undefined && source.loader.isMissing(t))
      t = t.z > source.coverage.minzoom ? ancestorAt(t, t.z - 1) : undefined;
    if (t !== undefined) out.set(tileKey(t), t);
  }
  return [...out.values()];
}
