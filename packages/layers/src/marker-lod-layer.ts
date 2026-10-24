/**
 * Marker level of detail (F374): a marker layer whose distant or dense markers draw as simplified symbols, a dot of a
 * point layer under it, and switch to the full marker by a cross-fade when they stand apart on screen. Density is
 * measured in screen bins over passes sliced across frames, so a tilted view's distant markers, crowded toward the
 * horizon, are simplified too. Two batches: two draw calls, whatever the number of markers.
 */
import { DataLayer, type DataLayerOptions } from './data-layer.js';
import type { FeatureId } from './feature-store.js';
import type { Feature, FeatureCollection } from './geojson.js';
import type { FrameContext, LayerContext } from './layer.js';
import type { LayerStyle } from './style.js';

/** How the layer decides and switches. */
export interface MarkerLodOptions {
  /** Side of a screen bin, CSS pixels (default 48). */
  readonly binPx?: number;
  /** Markers a bin may hold and still show them in full (default 1). */
  readonly maxPerBin?: number;
  /** Duration of the cross-fade between the two representations (default 250 ms). */
  readonly fadeMs?: number;
  /** Markers projected per frame while a pass runs (default 20,000). */
  readonly sliceSize?: number;
  /** Style of the simplified symbol (a point layer's `circle-*` properties; default a 3 px white dot). */
  readonly dotStyle?: LayerStyle;
}

/** Options of a marker layer with level of detail; features need no ids (they get them). */
export interface MarkerLodLayerOptions extends Omit<DataLayerOptions, 'data'> {
  readonly data?: FeatureCollection | readonly Feature[];
  readonly lod?: MarkerLodOptions;
}

/** Markers in each representation (the debug overlay's row, F374). */
export interface MarkerLodStats {
  readonly full: number;
  readonly simplified: number;
  readonly fading: number;
}

/** The simplified symbols: a point layer whose visibility is the complement of the markers' fade. */
class LodDots extends DataLayer {
  constructor(
    options: DataLayerOptions,
    private readonly fadeAt: (index: number) => number,
  ) {
    super('point', options);
  }

  protected override featureVisibility(index: number): number {
    return super.featureVisibility(index) * (1 - this.fadeAt(index));
  }

  /** Writes the visibility of feature `index` again after its fade changed. */
  refresh(index: number): void {
    this.writeVisibility(index, this.featureVisibility(index));
  }
}

let generated = 0;

/** Markers with level of detail (F374): `stack.add(new MarkerLodLayer({ data, style }))`. */
export class MarkerLodLayer extends DataLayer {
  readonly #dots: LodDots;
  readonly #binPx: number;
  readonly #maxPerBin: number;
  readonly #fadeMs: number;
  readonly #sliceSize: number;
  /** Per feature index: the fade toward the full marker (0 dot, 1 marker), and what the last pass decided. */
  #fade = new Float32Array(0);
  #target = new Uint8Array(0);
  /** Screen bin of each feature in the running pass, −1 off screen. */
  #bins = new Int32Array(0);
  readonly #counts = new Map<number, number>();
  /** Next feature to project in the running pass, or −1 when no pass runs. */
  #next = -1;
  readonly #fading = new Set<number>();
  #viewKey = '';
  #lastMs = NaN;
  #added = 0;

  constructor(options: MarkerLodLayerOptions = {}) {
    const { data, lod, ...rest } = options;
    super('marker', { ...rest, orderOffset: (rest.orderOffset ?? 0) + 1 });
    this.#binPx = lod?.binPx ?? 48;
    this.#maxPerBin = lod?.maxPerBin ?? 1;
    this.#fadeMs = lod?.fadeMs ?? 250;
    this.#sliceSize = lod?.sliceSize ?? 20_000;
    this.#dots = new LodDots(
      {
        id: this.id,
        orderOffset: rest.orderOffset ?? 0,
        pickable: false,
        ...(rest.placement === undefined ? {} : { placement: rest.placement }),
        style: lod?.dotStyle ?? { 'circle-color': '#ffffff', 'circle-radius': 3 },
      },
      (index) => this.#fade[index] ?? 0,
    );
    if (data !== undefined) this.addFeatures('features' in data ? data.features : data);
  }

  /** Markers in each representation. */
  get lodStats(): MarkerLodStats {
    let full = 0;
    for (let i = 0; i < this.store.count; i++) if ((this.#fade[i] ?? 0) >= 1) full++;
    return { full, simplified: this.store.count - full - this.#fading.size, fading: this.#fading.size };
  }

  /** Whether feature `id` shows as the full marker (or is fading toward it). */
  isFull(id: FeatureId): boolean {
    const index = this.store.indexOf(id);
    return index !== undefined && this.#target[index] === 1;
  }

  protected override featureVisibility(index: number): number {
    return super.featureVisibility(index) * (this.#fade[index] ?? 0);
  }

  /** Adds features to the markers and their simplified symbols, with ids (the two must share them). */
  override addFeatures(features: readonly Feature[]): void {
    // Both parts must give each feature the same id.
    const named = features.map((f) => (f.id === undefined ? { ...f, id: `${this.id}:${++generated}` } : f));
    const first = this.store.count;
    this.#grow(first + named.length);
    super.addFeatures(named);
    this.#dots.addFeatures(named);
    this.#added += named.length;
    for (let i = first; i < this.store.count; i++) this.#fade[i] = 0;
    this.#viewKey = '';
  }

  /** Changes one feature in both representations. */
  override updateFeature(id: FeatureId, update: Parameters<DataLayer['updateFeature']>[1]): boolean {
    this.#dots.updateFeature(id, update);
    return super.updateFeature(id, update);
  }

  /** Moves one feature in both representations; the next pass places it again. */
  override setFeaturePosition(id: FeatureId, longitudeDeg: number, latitudeDeg: number, heightMeters = 0): boolean {
    this.#dots.setFeaturePosition(id, longitudeDeg, latitudeDeg, heightMeters);
    this.#viewKey = '';
    return super.setFeaturePosition(id, longitudeDeg, latitudeDeg, heightMeters);
  }

  /** Shows or hides one feature in both representations. */
  override setFeatureVisible(id: FeatureId, visible: boolean): boolean {
    this.#dots.setFeatureVisible(id, visible);
    return super.setFeatureVisible(id, visible);
  }

  /** Removes one feature from both representations. */
  override removeFeature(id: FeatureId): boolean {
    const index = this.store.indexOf(id);
    if (index === undefined) return false;
    // The store moves its last feature into the freed index: the per-index state follows it.
    const last = this.store.count - 1;
    this.#fade[index] = this.#fade[last] ?? 0;
    this.#target[index] = this.#target[last] ?? 0;
    this.#fading.delete(last);
    this.#dots.removeFeature(id);
    this.#viewKey = '';
    return super.removeFeature(id);
  }

  /** Attaches both batches. */
  override attach(context: LayerContext): void {
    this.#dots.attach(context);
    super.attach(context);
  }

  /** Detaches both batches. */
  override detach(): void {
    this.#dots.detach();
    super.detach();
  }

  /** Orders the simplified symbols under the markers. */
  override setOrder(order: number): void {
    this.#dots.setOrder(order);
    super.setOrder(order);
  }

  /** Shows or hides both representations. */
  override setVisible(visible: boolean): void {
    this.#dots.setVisible(visible);
    super.setVisible(visible);
  }

  /** Decides the representations, advances the cross-fades, then flushes both batches. */
  override frame(frame: FrameContext): void {
    this.#decide(frame);
    this.#advance(frame.nowMs);
    this.#dots.frame(frame);
    super.frame(frame);
  }

  /** Starts a pass when the view moved, and projects the next slice of the running one. */
  #decide(frame: FrameContext): void {
    const key = this.#keyOf(frame);
    if (key !== this.#viewKey) {
      this.#viewKey = key;
      this.#next = 0;
      this.#counts.clear();
    }
    if (this.#next < 0) return;
    const count = this.store.count;
    const position = this.store.array('position');
    const end = Math.min(count, this.#next + this.#sliceSize);
    // Outside the view (with a bin of margin) a marker counts as simplified: it is decided again when it comes in.
    const viewport = frame.projector.viewportPx?.();
    const margin = this.#binPx;
    for (let i = this.#next; i < end; i++) {
      const point = frame.projector.geoToScreen({
        longitudeDeg: position[i * 3] ?? 0,
        latitudeDeg: position[i * 3 + 1] ?? 0,
        heightMeters: position[i * 3 + 2] ?? 0,
      });
      const outside =
        viewport !== undefined &&
        (point === undefined ||
          point.xPx < -margin ||
          point.yPx < -margin ||
          point.xPx > viewport.widthPx + margin ||
          point.yPx > viewport.heightPx + margin);
      if (!point || outside || this.featureVisibilityOf(i) <= 0) {
        this.#bins[i] = -1;
        continue;
      }
      const bin = Math.floor(point.xPx / this.#binPx) + Math.floor(point.yPx / this.#binPx) * 65_536;
      this.#bins[i] = bin;
      this.#counts.set(bin, (this.#counts.get(bin) ?? 0) + 1);
    }
    this.#next = end;
    this.context?.requestFrame();
    if (end < count) return;
    // The pass is complete: markers alone enough in their bin show in full, the others as dots.
    this.#next = -1;
    for (let i = 0; i < count; i++) {
      const bin = this.#bins[i] ?? -1;
      const target = bin >= 0 && (this.#counts.get(bin) ?? 0) <= this.#maxPerBin ? 1 : 0;
      if (target === this.#target[i]) continue;
      this.#target[i] = target;
      this.#fading.add(i);
    }
  }

  /** Moves every fading feature toward its target, the cross-fade taking `fadeMs`. */
  #advance(nowMs: number): void {
    const elapsed = Number.isNaN(this.#lastMs) ? 0 : Math.max(0, nowMs - this.#lastMs);
    this.#lastMs = nowMs;
    if (this.#fading.size === 0) return;
    const step = this.#fadeMs > 0 ? elapsed / this.#fadeMs : 1;
    for (const i of this.#fading) {
      const target = this.#target[i] ?? 0;
      const current = this.#fade[i] ?? 0;
      const next = target > current ? Math.min(target, current + step) : Math.max(target, current - step);
      this.#fade[i] = next;
      if (next === target) this.#fading.delete(i);
      this.writeVisibility(i, this.featureVisibility(i));
      this.#dots.refresh(i);
    }
    this.context?.requestFrame();
  }

  /** The view, as the screen position of the first feature and the zoom: a pass starts when it changes. */
  #keyOf(frame: FrameContext): string {
    if (this.store.count === 0) return '';
    const p = this.store.array('position');
    const point = frame.projector.geoToScreen({ longitudeDeg: p[0] ?? 0, latitudeDeg: p[1] ?? 0 });
    const x = point ? Math.round(point.xPx * 2) : 'off';
    const y = point ? Math.round(point.yPx * 2) : 'off';
    return `${String(x)},${String(y)},${frame.zoom.toFixed(3)},${String(this.#added)}`;
  }

  /** The feature's own visibility, before the fade. */
  private featureVisibilityOf(index: number): number {
    return super.featureVisibility(index);
  }

  #grow(count: number): void {
    if (count <= this.#fade.length) return;
    const size = Math.max(count, this.#fade.length * 2);
    const fade = new Float32Array(size);
    fade.set(this.#fade);
    this.#fade = fade;
    const target = new Uint8Array(size);
    target.set(this.#target);
    this.#target = target;
    this.#bins = new Int32Array(size);
  }
}
