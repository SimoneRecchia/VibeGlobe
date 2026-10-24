// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * A layer that loads vector data (GeoJSON now; KML, GPX and MVT through the M7 adapters) from a URL, a File or memory
 * and draws each geometry family with its own batch: polygons at the bottom, lines above, points on top (F371).
 */
import { acquireWorkerPool, type WorkerEndpointFactory } from '@vibeglobe/core';
import { DataLayer } from './data-layer.js';
import type { FeatureId } from './feature-store.js';
import { geometryFamily, type Feature, type FeatureCollection, type GeometryFamily } from './geojson.js';
import { LayerEmitter, type FrameContext, type Layer, type LayerContext, type LayerEvents } from './layer.js';
import type { Placement } from './render-target.js';
import type { LayerStyle } from './style.js';
import { geojsonFormat, loadVectorData, type VectorFormatAdapter, type VectorSource } from './vector-format.js';

/** Options of a vector data layer. */
export interface GeoJsonLayerOptions {
  readonly id?: string;
  /** Where the data comes from; loading starts when the layer is added. */
  readonly data: VectorSource | FeatureCollection;
  /** The format adapter: `geojsonFormat` (default), `kmlFormat` or `gpxFormat`. */
  readonly format?: VectorFormatAdapter;
  /** Styles per family: `circle-*` for points, `line-*` for lines, `fill-*` for polygons. */
  readonly style?: { readonly point?: LayerStyle; readonly line?: LayerStyle; readonly polygon?: LayerStyle };
  readonly placement?: Placement;
  /** The fetch used for URLs. */
  readonly fetch?: (url: string) => Promise<Response>;
  /**
   * The engine's worker program (`createWorkers()` of `@vibeglobe/worker`, as given to the globe): the data is parsed
   * in its page-wide pool, off the main thread (F371). Without it parsing runs on the main thread.
   */
  readonly workers?: WorkerEndpointFactory;
}

let generated = 0;
/** The pool's timers, from the page. */
const TIMERS = {
  set: (callback: () => void, delayMs: number): unknown => setTimeout(callback, delayMs),
  clear: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
const FAMILIES: readonly GeometryFamily[] = ['polygon', 'line', 'point'];

/** Vector data drawn as points, lines and polygons. */
export class GeoJsonLayer implements Layer {
  readonly id: string;
  readonly #options: GeoJsonLayerOptions;
  readonly #events = new LayerEmitter();
  readonly #parts: Readonly<Record<GeometryFamily, DataLayer>>;
  #loading: Promise<void> | undefined;
  #attached = false;
  /** Whether the features are in the parts' stores, which keep them across a remove and a re-add. */
  #added = false;
  /** Counts attaches, so a load started before a detach never adds its features. */
  #generation = 0;

  constructor(options: GeoJsonLayerOptions) {
    this.id = options.id ?? `geojson-layer-${++generated}`;
    this.#options = options;
    const placement = options.placement === undefined ? {} : { placement: options.placement };
    const part = (
      kind: 'point' | 'polyline' | 'polygon',
      style: LayerStyle | undefined,
      orderOffset: number,
    ): DataLayer =>
      new DataLayer(kind, { id: this.id, ...placement, orderOffset, ...(style === undefined ? {} : { style }) });
    this.#parts = {
      polygon: part('polygon', options.style?.polygon, 0),
      line: part('polyline', options.style?.line, 1),
      point: part('point', options.style?.point, 2),
    };
  }

  /** Resolves when the data is loaded (or failed: the error event carries the reason). */
  get loaded(): Promise<void> {
    return this.#loading ?? Promise.resolve();
  }

  /** Features per family. */
  get featureCounts(): Readonly<Record<GeometryFamily, number>> {
    return {
      point: this.#parts.point.featureCount,
      line: this.#parts.line.featureCount,
      polygon: this.#parts.polygon.featureCount,
    };
  }

  /** The batch layer of one family (for styling and updates). */
  part(family: GeometryFamily): DataLayer {
    return this.#parts[family];
  }

  /** Adds a handler for a layer event. */
  on<K extends keyof LayerEvents>(type: K, handler: (payload: LayerEvents[K]) => void): () => void {
    return this.#events.on(type, handler);
  }

  /** Emits an event to this layer's handlers. */
  emit<K extends keyof LayerEvents>(type: K, payload: LayerEvents[K]): void {
    this.#events.emit(type, payload);
  }

  /** Sets a feature's state in whichever family holds it. */
  setFeatureState(id: FeatureId, state: Readonly<Record<string, unknown>> | undefined): boolean {
    return FAMILIES.some((family) => this.#parts[family].setFeatureState(id, state));
  }

  /** Handlers registered on this layer and its parts. */
  get listenerCount(): number {
    return this.#events.listenerCount + FAMILIES.reduce((sum, f) => sum + this.#parts[f].listenerCount, 0);
  }

  /** Attaches the three batches and starts loading. */
  attach(context: LayerContext): void {
    for (const family of FAMILIES) this.#parts[family].attach(context);
    this.#attached = true;
    this.#generation++;
    if (!this.#added) this.#loading = this.#load(this.#generation);
  }

  /** Detaches the batches; a load still running is ignored when it ends. */
  detach(): void {
    this.#attached = false;
    for (const family of FAMILIES) this.#parts[family].detach();
    this.#events.clear();
  }

  /** Sets the position in the stack. */
  setOrder(order: number): void {
    for (const family of FAMILIES) this.#parts[family].setOrder(order);
  }

  /** Shows or hides every family. */
  setVisible(visible: boolean): void {
    for (const family of FAMILIES) this.#parts[family].setVisible(visible);
  }

  /** Runs the frame step of each family. */
  frame(frame: FrameContext): void {
    for (const family of FAMILIES) this.#parts[family].frame(frame);
  }

  async #load(generation: number): Promise<void> {
    const data = this.#options.data;
    try {
      // An in-memory FeatureCollection is GeoJSON whatever the format option says.
      const isCollection =
        typeof data === 'object' && data !== null && (data as Partial<FeatureCollection>).type === 'FeatureCollection';
      const format = isCollection ? geojsonFormat : (this.#options.format ?? geojsonFormat);
      const lease = this.#options.workers && acquireWorkerPool(this.#options.workers, { timers: TIMERS });
      const collection = await loadVectorData(data, format, this.#options.fetch, lease?.pool).finally(() =>
        lease?.release(),
      );
      if (!this.#attached || generation !== this.#generation) return;
      this.#added = true;
      for (const issue of collection.issues) {
        const where = issue.index < 0 ? '' : `feature ${issue.index}: `;
        this.#events.emit('error', { message: `${format.format}: ${where}${issue.message}` });
      }
      const byFamily: Record<GeometryFamily, Feature[]> = { point: [], line: [], polygon: [] };
      for (const feature of collection.features) {
        if (feature.geometry !== null) byFamily[geometryFamily(feature.geometry)].push(feature);
      }
      for (const family of FAMILIES) this.#parts[family].addFeatures(byFamily[family]);
      this.#events.emit('data', { added: collection.features.length, total: collection.features.length });
    } catch (cause) {
      if (this.#attached && generation === this.#generation)
        this.#events.emit('error', { message: cause instanceof Error ? cause.message : String(cause), cause });
    }
  }
}
