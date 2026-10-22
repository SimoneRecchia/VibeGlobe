/**
 * A clustered point or marker layer (F373): the shown features are the clusters and single points of the current
 * integer zoom, styled like any point layer (clusters carry `cluster`, `cluster_id`, `point_count` and
 * `point_count_abbreviated`, as in MapLibre). When the zoom crosses an integer, clusters split and merge with an
 * animation: zooming in, children move out from the cluster they leave while it fades out; zooming out, children move
 * into the cluster that absorbs them while it fades in. Nothing pops.
 */
import {
  boundsOf,
  localClusterEngine,
  type ClusterEngine,
  type ClusterItem,
  type ClusterOptions,
  type GeoBoundsDeg,
} from './cluster.js';
import { DataLayer, type DataLayerOptions } from './data-layer.js';
import type { FeatureId } from './feature-store.js';
import type { Feature, FeatureCollection } from './geojson.js';
import type { FrameContext, LayerContext, PickedFeature } from './layer.js';

/** Options of a clustered layer. */
export interface ClusterLayerOptions extends Omit<DataLayerOptions, 'data'> {
  readonly kind?: 'point' | 'marker';
  /** Point features (other geometries are rejected). */
  readonly data?: FeatureCollection | readonly Feature[];
  readonly cluster?: ClusterOptions;
  /** Where the index is built; the worker pool's engine once it exists. */
  readonly engine?: ClusterEngine;
}

interface Transition {
  readonly key: string;
  readonly fromLon: number;
  readonly fromLat: number;
  readonly toLon: number;
  readonly toLat: number;
  readonly fromOpacity: number;
  readonly toOpacity: number;
  readonly removeAtEnd: boolean;
}

const WORLD_PX = 512;

function mercator(lonDeg: number, latDeg: number): [number, number] {
  const sin = Math.min(0.9999, Math.max(-0.9999, Math.sin((latDeg * Math.PI) / 180)));
  return [lonDeg / 360 + 0.5, 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)];
}

/** Finds, for an item, the nearest item of another set within one cluster radius (a grid of radius-sized cells). */
class NearestGrid {
  readonly #cells = new Map<string, ClusterItem[]>();
  readonly #cell: number;

  constructor(items: Iterable<ClusterItem>, cellWorld: number) {
    this.#cell = cellWorld;
    for (const item of items) {
      const [x, y] = mercator(item.longitudeDeg, item.latitudeDeg);
      const key = `${Math.floor(x / cellWorld)},${Math.floor(y / cellWorld)}`;
      const list = this.#cells.get(key);
      if (list === undefined) this.#cells.set(key, [item]);
      else list.push(item);
    }
  }

  nearest(item: ClusterItem): ClusterItem | undefined {
    const [x, y] = mercator(item.longitudeDeg, item.latitudeDeg);
    const cx = Math.floor(x / this.#cell);
    const cy = Math.floor(y / this.#cell);
    let best: ClusterItem | undefined;
    let bestDistance = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const other of this.#cells.get(`${cx + dx},${cy + dy}`) ?? []) {
          const [ox, oy] = mercator(other.longitudeDeg, other.latitudeDeg);
          const distance = (ox - x) ** 2 + (oy - y) ** 2;
          if (distance < bestDistance) {
            best = other;
            bestDistance = distance;
          }
        }
      }
    }
    return best;
  }
}

/** Points clustered by zoom. */
export class ClusterLayer extends DataLayer {
  readonly #engine: ClusterEngine;
  readonly #options: ClusterOptions;
  #points: readonly Feature[] = [];
  #lonLat = new Float64Array(0);
  #loaded: Promise<void> = Promise.resolve();
  #generation = 0;
  #requestedZoom: number | undefined;
  #shownZoom: number | undefined;
  #pending: { zoom: number; items: readonly ClusterItem[] } | undefined;
  readonly #shown = new Map<string, ClusterItem>();
  readonly #opacity = new Map<string, number>();
  #transitions: Transition[] = [];
  #transitionStartMs = 0;

  constructor(options: ClusterLayerOptions = {}) {
    const { data, cluster, engine, kind, ...rest } = options;
    super(kind ?? 'point', rest);
    this.#engine = engine ?? localClusterEngine();
    this.#options = cluster ?? {};
    if (data !== undefined) this.setData(data);
  }

  /** Replaces every point; the index is rebuilt. */
  setData(data: FeatureCollection | readonly Feature[]): void {
    const features = 'features' in data ? data.features : data;
    const lonLat = new Float64Array(features.length * 2);
    features.forEach((feature, i) => {
      if (feature.geometry?.type !== 'Point') throw new TypeError('clustered layers take Point features');
      lonLat[2 * i] = feature.geometry.coordinates[0] ?? 0;
      lonLat[2 * i + 1] = feature.geometry.coordinates[1] ?? 0;
    });
    this.#finishTransitions();
    for (const key of [...this.#shown.keys()]) this.#removeItem(key);
    this.#shownZoom = undefined;
    this.#pending = undefined;
    this.#points = features;
    this.#lonLat = lonLat;
    this.#generation++;
    this.#requestedZoom = undefined;
    this.#loaded = this.#engine.load(lonLat, this.#options);
  }

  /** Resolves once the index for the current data is built. */
  get loaded(): Promise<void> {
    return this.#loaded;
  }

  /** Number of points loaded. */
  get pointCount(): number {
    return this.#points.length;
  }

  /** The integer zoom whose clusters are shown. */
  get shownZoom(): number | undefined {
    return this.#shownZoom;
  }

  /** Points the shown items stand for (items fading out excluded): the number of points loaded. */
  shownPointCount(): number {
    let total = 0;
    for (const item of this.#shown.values()) total += item.count;
    return total;
  }

  /** The items currently shown, by key. */
  shownItems(): readonly ClusterItem[] {
    return [...this.#shown.values()];
  }

  /** The original feature of a single point shown as `p<index>`. */
  pointFeature(pointIndex: number): Feature | undefined {
    return this.#points[pointIndex];
  }

  /** The zoom at which a cluster splits and the bounds of its points (clicking a cluster zooms to its extent). */
  async clusterExtent(clusterId: number): Promise<{ expansionZoom: number; bounds: GeoBoundsDeg | undefined }> {
    const [expansionZoom, leaves] = await Promise.all([
      this.#engine.expansionZoom(clusterId),
      this.#engine.leaves(clusterId),
    ]);
    return { expansionZoom, bounds: boundsOf(this.#lonLat, leaves) };
  }

  /** Detaches and frees the index. */
  override detach(): void {
    this.#generation++;
    super.detach();
    this.#engine.destroy();
  }

  /** Starts showing the clusters of the current zoom once attached. */
  override attach(context: LayerContext): void {
    super.attach(context);
    this.#requestedZoom = undefined;
  }

  /** Single points are reported as the original feature, clusters with their cluster properties. */
  protected override featureAt(index: number): PickedFeature | undefined {
    const picked = super.featureAt(index);
    const item = picked === undefined ? undefined : this.#shown.get(String(picked.id));
    if (picked === undefined || item?.pointIndex === undefined) return picked;
    const source = this.#points[item.pointIndex];
    return { layerId: this.id, id: source?.id ?? item.pointIndex, properties: source?.properties ?? {} };
  }

  protected override featureVisibility(index: number): number {
    const id = this.store.idAt(index);
    return super.featureVisibility(index) * (id === undefined ? 1 : (this.#opacity.get(String(id)) ?? 1));
  }

  protected override beforeFlush(frame: FrameContext): void {
    const zoom = Math.max(0, Math.floor(frame.zoom));
    if (zoom !== this.#requestedZoom) this.#request(zoom);
    if (this.#pending !== undefined) {
      this.#apply(this.#pending.zoom, this.#pending.items, frame.nowMs);
      this.#pending = undefined;
    }
    this.#animate(frame.nowMs);
  }

  #request(zoom: number): void {
    this.#requestedZoom = zoom;
    const generation = this.#generation;
    void this.#loaded
      .then(() => this.#engine.items(zoom))
      .then((items) => {
        if (generation === this.#generation && zoom === this.#requestedZoom) this.#pending = { zoom, items };
      })
      .catch((cause: unknown) => this.emit('error', { message: `clustering failed: ${String(cause)}`, cause }));
  }

  #apply(zoom: number, items: readonly ClusterItem[], nowMs: number): void {
    this.#finishTransitions();
    const previous = new Map(this.#shown);
    const next = new Map(items.map((item) => [item.key, item]));
    const zoomingIn = this.#shownZoom === undefined || zoom > this.#shownZoom;
    const animate = this.#shownZoom !== undefined && (this.#options.transitionMs ?? 300) > 0;
    const coarser = zoomingIn ? (this.#shownZoom ?? zoom) : zoom;
    const cell = (this.#options.radiusPx ?? 50) / (WORLD_PX * 2 ** coarser);
    const towardOld = animate && zoomingIn ? new NearestGrid(previous.values(), cell) : undefined;
    const towardNew = animate && !zoomingIn ? new NearestGrid(next.values(), cell) : undefined;
    const added: Feature[] = [];
    for (const [key, item] of next) {
      if (previous.has(key)) continue;
      added.push(this.#itemFeature(item));
      if (!animate) continue;
      const origin = towardOld?.nearest(item);
      this.#transitions.push(this.#transition(item, origin ?? item, item, 0, 1, false));
    }
    for (const [key, item] of previous) {
      if (next.has(key)) continue;
      if (!animate) {
        this.#removeItem(key);
        continue;
      }
      const destination = towardNew?.nearest(item);
      this.#transitions.push(this.#transition(item, item, destination ?? item, 1, 0, true));
      this.#shown.delete(key);
    }
    this.addFeatures(added);
    this.#shownZoom = zoom;
    this.#transitionStartMs = nowMs;
  }

  #transition(
    item: ClusterItem,
    from: ClusterItem,
    to: ClusterItem,
    fromOpacity: number,
    toOpacity: number,
    removeAtEnd: boolean,
  ): Transition {
    this.#opacity.set(item.key, fromOpacity);
    return {
      key: item.key,
      fromLon: from.longitudeDeg,
      fromLat: from.latitudeDeg,
      toLon: to.longitudeDeg,
      toLat: to.latitudeDeg,
      fromOpacity,
      toOpacity,
      removeAtEnd,
    };
  }

  #animate(nowMs: number): void {
    if (this.#transitions.length === 0) return;
    const duration = this.#options.transitionMs ?? 300;
    const t = Math.min(1, (nowMs - this.#transitionStartMs) / duration);
    const eased = t * t * (3 - 2 * t);
    for (const transition of this.#transitions) {
      this.#opacity.set(
        transition.key,
        transition.fromOpacity + (transition.toOpacity - transition.fromOpacity) * eased,
      );
      this.setFeaturePosition(
        transition.key,
        transition.fromLon + (transition.toLon - transition.fromLon) * eased,
        transition.fromLat + (transition.toLat - transition.fromLat) * eased,
      );
      const index = this.store.indexOf(transition.key);
      if (index !== undefined) this.writeVisibility(index, this.featureVisibility(index));
    }
    if (t >= 1) this.#finishTransitions();
  }

  #finishTransitions(): void {
    for (const transition of this.#transitions) {
      if (transition.removeAtEnd) this.#removeItem(transition.key);
      else {
        this.#opacity.delete(transition.key);
        this.setFeaturePosition(transition.key, transition.toLon, transition.toLat);
        const index = this.store.indexOf(transition.key);
        if (index !== undefined) this.writeVisibility(index, this.featureVisibility(index));
      }
    }
    this.#transitions = [];
  }

  #itemFeature(item: ClusterItem): Feature {
    this.#shown.set(item.key, item);
    const source = item.pointIndex === undefined ? undefined : this.#points[item.pointIndex];
    const properties: Record<string, unknown> =
      item.clusterId === undefined
        ? { ...source?.properties }
        : {
            cluster: true,
            cluster_id: item.clusterId,
            point_count: item.count,
            point_count_abbreviated: item.count >= 1000 ? `${Math.round(item.count / 100) / 10}k` : item.count,
          };
    return {
      type: 'Feature',
      id: item.key,
      properties,
      geometry: { type: 'Point', coordinates: [item.longitudeDeg, item.latitudeDeg] },
    };
  }

  #removeItem(key: FeatureId): void {
    this.#opacity.delete(String(key));
    this.#shown.delete(String(key));
    this.removeFeature(key);
  }
}
