/**
 * The built-in data layer: one batch of points, markers, labels, lines, polygons or circles, styled by MapLibre
 * expressions and updated feature by feature (F369, F370, F372, F376, F377).
 */
import type { FeatureGeometry, GeoPosition, ScreenPoint } from '@vibeglobe/core';
import { anchorNear, type Project } from './anchors.js';
import { FeatureStore, type FeatureId } from './feature-store.js';
import type { DataLayerStats, FeatureUpdate } from './data-layer-types.js';
import { ellipseGeometry } from './circle.js';
import {
  anchorOf,
  toFeatureGeometry,
  writePosition,
  type Feature,
  type FeatureCollection,
  type Geometry,
} from './geojson.js';
import {
  LayerEmitter,
  ORDER_STRIDE,
  type FrameContext,
  type Layer,
  type LayerContext,
  type LayerEvents,
  type PickedFeature,
} from './layer.js';
import { packPickId } from './picking.js';
import {
  ATTRIBUTE_COMPONENTS,
  type BatchAttribute,
  type BatchHandle,
  type BatchKind,
  type Placement,
} from './render-target.js';
import {
  compileStyle,
  evaluateProperty,
  isStringChannel,
  type CompiledProperty,
  type CompiledStyle,
  type LayerStyle,
} from './style.js';

/** Data a layer starts with: a collection, an array of features, or a stream of feature chunks. */
export type LayerData = FeatureCollection | readonly Feature[] | AsyncIterable<readonly Feature[]>;

/** Options shared by the built-in layers. */
export interface DataLayerOptions {
  /** Unique within the stack; generated when omitted. */
  readonly id?: string;
  readonly data?: LayerData;
  readonly style?: LayerStyle;
  /** Default 'clamp-to-ground' for points, markers and labels, 'drape' for lines and polygons. */
  readonly placement?: Placement;
  /** The layer draws only for zoom in [minZoom, maxZoom) (MapLibre semantics). */
  readonly minZoom?: number;
  readonly maxZoom?: number;
  /** Whether features write pick ids (default true). */
  readonly pickable?: boolean;
  /** Whether features can be dragged with the pointer (default false, F382). */
  readonly draggable?: boolean;
  /** Features to reserve room for, so features streamed in later are added without rebuilding the batch (F372). */
  readonly capacity?: number;
  /** Added to the batch's draw order within the layer's band (0 to ORDER_STRIDE − 1; composite layers use it). */
  readonly orderOffset?: number;
}

let generatedIds = 0;
const scratch = new Float64Array(4);

export type { DataLayerStats, FeatureUpdate } from './data-layer-types.js';

/** A layer of one primitive kind. */
export class DataLayer implements Layer {
  readonly id: string;
  readonly kind: BatchKind;
  readonly placement: Placement;
  /** Whether features can be dragged. */
  readonly draggable: boolean;
  readonly stats: DataLayerStats = { featureEvaluations: 0, fullEvaluations: 0 };
  protected readonly store: FeatureStore;
  protected context: LayerContext | undefined;
  protected handle: BatchHandle | undefined;
  readonly #events = new LayerEmitter();
  #style: CompiledStyle;
  #perFeature: CompiledProperty[] = [];
  #uniforms: CompiledProperty[] = [];
  readonly #uniformValues = new Map<BatchAttribute, Float64Array>();
  #sortKey: CompiledProperty | undefined;
  readonly #sortKeys = new Map<FeatureId, number>();
  readonly #hidden = new Set<FeatureId>();
  readonly #states = new Map<FeatureId, Record<string, unknown>>();
  readonly #minZoom: number;
  readonly #maxZoom: number;
  readonly #pickable: boolean;
  #slot = 0;
  readonly #orderOffset: number;
  #order = 0;
  #visible = true;
  #drawn: boolean | undefined;
  #zoom = NaN;
  #stream: AsyncIterable<readonly Feature[]> | undefined;
  #streaming = false;

  constructor(kind: BatchKind, options: DataLayerOptions = {}) {
    this.kind = kind;
    this.id = options.id ?? `${kind}-layer-${++generatedIds}`;
    this.placement =
      options.placement ??
      (kind === 'polyline' || kind === 'polygon' || kind === 'circle' ? 'drape' : 'clamp-to-ground');
    this.#minZoom = options.minZoom ?? 0;
    this.#maxZoom = options.maxZoom ?? 24;
    this.#pickable = options.pickable ?? true;
    this.draggable = options.draggable ?? false;
    this.#orderOffset = options.orderOffset ?? 0;
    this.#style = compileStyle(kind, options.style);
    this.#splitStyle();
    this.store = new FeatureStore(options.capacity);
    const data = options.data;
    if (data !== undefined && Symbol.asyncIterator in data) this.#stream = data;
    else if (data !== undefined) this.addFeatures('features' in data ? data.features : data);
  }

  /** Number of features. */
  get featureCount(): number {
    return this.store.count;
  }

  /** Adds a handler for a layer event; returns its remover. */
  on<K extends keyof LayerEvents>(type: K, handler: (payload: LayerEvents[K]) => void): () => void {
    return this.#events.on(type, handler);
  }

  /** Emits an event to this layer's handlers (the stack's interaction controller calls it). */
  emit<K extends keyof LayerEvents>(type: K, payload: LayerEvents[K]): void {
    this.#events.emit(type, payload);
  }

  /** Handlers currently registered (leak checks, F385). */
  get listenerCount(): number {
    return this.#events.listenerCount;
  }

  /** Replaces the style; every feature is re-evaluated. */
  setStyle(style: LayerStyle): void {
    this.#style = compileStyle(this.kind, style);
    this.#splitStyle();
    this.#zoom = NaN;
    this.#evaluateAll(this.#zoomOrZero());
  }

  /**
   * Appends features (a streamed chunk or application data); they draw from the next frame.
   * @throws TypeError for a feature without geometry or with invalid coordinates, Error for a duplicate id.
   */
  addFeatures(features: readonly Feature[]): void {
    const zoom = this.#zoomOrZero();
    for (const feature of features) {
      if (feature.geometry === null) throw new TypeError('feature without geometry');
      const id = feature.id ?? `${this.id}:${this.store.count}:${++generatedIds}`;
      const index = this.store.add(
        id,
        { ...feature.properties },
        this.#geometryOf(feature.geometry, feature.properties),
      );
      this.#writeAnchor(index, anchorOf(feature.geometry));
      this.#writeIdentity(index);
      this.#evaluate(index, zoom, feature.geometry.type);
    }
    this.#events.emit('data', { added: features.length, total: this.store.count });
  }

  /**
   * Changes one feature's position, geometry or properties; only that feature is re-uploaded.
   * @returns false when the id is unknown.
   */
  updateFeature(id: FeatureId, update: FeatureUpdate): boolean {
    const index = this.store.indexOf(id);
    if (index === undefined) return false;
    if (update.position !== undefined) {
      const p = update.position;
      this.#writeAnchor(index, 'longitudeDeg' in p ? [p.longitudeDeg, p.latitudeDeg, p.heightMeters ?? 0] : p);
    }
    if (update.geometry !== undefined) {
      const geometry = this.#geometryOf(update.geometry, this.store.propertiesAt(index));
      if (geometry !== undefined) this.store.setGeometry(index, geometry);
      if (update.position === undefined) this.#writeAnchor(index, anchorOf(update.geometry));
    }
    if (update.properties !== undefined) {
      const merged =
        update.replace === true
          ? { ...update.properties }
          : { ...this.store.propertiesAt(index), ...update.properties };
      this.store.setProperties(index, merged);
      this.#evaluate(index, this.#zoomOrZero());
    }
    return true;
  }

  /** Moves one feature (the allocation-free path for live feeds, F378). */
  setFeaturePosition(id: FeatureId, longitudeDeg: number, latitudeDeg: number, heightMeters = 0): boolean {
    return this.#writeVector(id, 'position', longitudeDeg, latitudeDeg, heightMeters, 0);
  }

  /**
   * Recolors one feature with straight RGBA in 0–1, allocating nothing (the style path for live feeds, F378). The color
   * holds until the feature's style is evaluated again (a property or feature-state change, a zoom-dependent style).
   */
  setFeatureColor(id: FeatureId, red: number, green: number, blue: number, alpha = 1): boolean {
    return this.#writeVector(id, 'color', red, green, blue, alpha);
  }

  #writeVector(id: FeatureId, attribute: 'position' | 'color', a: number, b: number, c: number, d: number): boolean {
    const index = this.store.indexOf(id);
    if (index === undefined) return false;
    scratch[0] = a;
    scratch[1] = b;
    scratch[2] = c;
    scratch[3] = d;
    this.store.set(attribute, index, scratch);
    return true;
  }

  /** Shows or hides one feature. */
  setFeatureVisible(id: FeatureId, visible: boolean): boolean {
    const index = this.store.indexOf(id);
    if (index === undefined) return false;
    if (visible) this.#hidden.delete(id);
    else this.#hidden.add(id);
    this.writeVisibility(index, this.featureVisibility(index));
    return true;
  }

  /**
   * Sets a feature's state, read by `['feature-state', name]` expressions (hover and selection styles, F379, F381).
   * The feature is re-evaluated; `undefined` clears the state.
   */
  setFeatureState(id: FeatureId, state: Readonly<Record<string, unknown>> | undefined): boolean {
    const index = this.store.indexOf(id);
    if (index === undefined) return false;
    if (state === undefined) this.#states.delete(id);
    else this.#states.set(id, { ...this.#states.get(id), ...state });
    this.#evaluate(index, this.#zoomOrZero());
    return true;
  }

  /** The state set on a feature. */
  getFeatureState(id: FeatureId): Readonly<Record<string, unknown>> | undefined {
    return this.#states.get(id);
  }

  /** Removes one feature; the last feature moves into its place. */
  removeFeature(id: FeatureId): boolean {
    const index = this.store.indexOf(id);
    if (index === undefined) return false;
    this.#hidden.delete(id);
    this.#states.delete(id);
    this.#sortKeys.delete(id);
    const moved = this.store.remove(id);
    if (moved !== undefined) this.#writeIdentity(moved);
    return true;
  }

  /** The feature with an id, as events carry it. */
  getFeature(id: FeatureId): PickedFeature | undefined {
    const index = this.store.indexOf(id);
    return index === undefined ? undefined : this.featureAt(index);
  }

  /** A feature's anchor position. */
  getPosition(id: FeatureId): GeoPosition | undefined {
    const index = this.store.indexOf(id);
    if (index === undefined) return undefined;
    const p = this.store.array('position');
    return { longitudeDeg: p[3 * index] ?? 0, latitudeDeg: p[3 * index + 1] ?? 0, heightMeters: p[3 * index + 2] ?? 0 };
  }

  /** Whether a feature anchor shows within `radiusPx` of `point` (a press that starts a drag, F382). */
  anchorNear(point: ScreenPoint, radiusPx: number, project: Project): boolean {
    return anchorNear(this.store, point, radiusPx, project, this.placement === 'clamp-to-ground');
  }

  /** Creates the batch and pick slot and starts reading a streamed data source. */
  attach(context: LayerContext): void {
    if (this.context !== undefined) throw new Error(`layer ${this.id} is already in a stack`);
    this.context = context;
    this.store.onDirty = () => context.requestFrame();
    this.handle = context.target.createBatch({
      kind: this.kind,
      layerId: this.id,
      capacity: this.store.capacity,
      placement: this.placement,
    });
    if (this.#pickable) this.#slot = context.acquirePickSlot((index) => this.featureAt(index));
    for (let i = 0; i < this.store.count; i++) this.#writeIdentity(i);
    this.store.markAllDirty();
    this.#drawn = undefined;
    context.target.setOrder(this.handle, this.#order * ORDER_STRIDE + this.#orderOffset);
    if (this.#stream !== undefined) void this.#consume(this.#stream);
  }

  /** Frees the batch and pick slot, stops the stream and removes every handler. */
  detach(): void {
    const context = this.context;
    if (context === undefined) return;
    this.store.onDirty = undefined;
    this.#streaming = false;
    if (this.handle !== undefined) context.target.release(this.handle);
    if (this.#slot !== 0) context.releasePickSlot(this.#slot);
    this.#slot = 0;
    this.handle = undefined;
    this.context = undefined;
    this.#events.clear();
  }

  /** Sets the layer's position in the stack. */
  setOrder(order: number): void {
    this.#order = order;
    if (this.context !== undefined && this.handle !== undefined)
      this.context.target.setOrder(this.handle, order * ORDER_STRIDE + this.#orderOffset);
  }

  /** Shows or hides the layer, from the next frame, which it asks for (KB-113). */
  setVisible(visible: boolean): void {
    this.#visible = visible;
    this.context?.requestFrame();
  }

  /** Whether the layer is shown (independent of its zoom range). */
  get visible(): boolean {
    return this.#visible;
  }

  /** Applies zoom-dependent styles and visibility, then uploads what changed. */
  frame(frame: FrameContext): void {
    const { context, handle } = this;
    if (context === undefined || handle === undefined) return;
    const drawn = this.#visible && frame.zoom >= this.#minZoom && frame.zoom < this.#maxZoom;
    if (drawn !== this.#drawn) {
      context.target.setVisible(handle, drawn);
      this.#drawn = drawn;
    }
    if (frame.zoom !== this.#zoom) {
      this.#applyUniforms(frame.zoom);
      if (this.#perFeature.some((p) => p.kind === 'composite')) this.#evaluateAll(frame.zoom);
      this.#zoom = frame.zoom;
    }
    this.beforeFlush(frame);
    if (this.store.dirty) this.store.flush(context.target, handle);
  }

  /** Hook for subclasses (label placement) to adjust features before the frame's upload. */
  protected beforeFlush(frame: FrameContext): void {
    void frame;
  }

  /** The application visibility of a feature (1 shown, 0 hidden by {@link DataLayer.setFeatureVisible}). */
  protected featureVisibility(index: number): number {
    const id = this.store.idAt(index);
    return id !== undefined && this.#hidden.has(id) ? 0 : 1;
  }

  /** Writes the uploaded visibility factor of a feature. */
  protected writeVisibility(index: number, value: number): void {
    this.store.setScalar('visible', index, value);
  }

  /** The feature at an index, as events carry it. */
  protected featureAt(index: number): PickedFeature | undefined {
    const id = this.store.idAt(index);
    return id === undefined ? undefined : { layerId: this.id, id, properties: this.store.propertiesAt(index) };
  }

  /** A feature's value of an attribute: the layer-wide value of a zoom-only or constant style, else its own. */
  protected attributeValue(attribute: BatchAttribute, index: number, component: number): number {
    const uniform = this.#uniformValues.get(attribute);
    if (uniform !== undefined) return uniform[component] ?? 0;
    return this.store.array(attribute)[index * ATTRIBUTE_COMPONENTS[attribute] + component] ?? 0;
  }

  /** The sort key (`symbol-sort-key`) of a feature, evaluated with its style; 0 when the style has none. */
  protected sortKey(index: number): number {
    const id = this.store.idAt(index);
    return id === undefined ? 0 : (this.#sortKeys.get(id) ?? 0);
  }

  async #consume(stream: AsyncIterable<readonly Feature[]>): Promise<void> {
    this.#streaming = true;
    this.#stream = undefined;
    try {
      for await (const chunk of stream) {
        if (!this.#streaming) return;
        this.addFeatures(chunk);
      }
    } catch (cause) {
      if (this.#streaming) this.#events.emit('error', { message: `stream failed: ${String(cause)}`, cause });
    }
  }

  #splitStyle(): void {
    const perFeature = (p: CompiledProperty): boolean =>
      isStringChannel(p.channel) || p.kind === 'source' || p.kind === 'composite';
    this.#perFeature = this.#style.properties.filter((p) => p.channel !== 'sortKey' && perFeature(p));
    this.#uniforms = this.#style.properties.filter((p) => p.channel !== 'sortKey' && !perFeature(p));
    this.#uniformValues.clear();
    this.#sortKey = this.#style.properties.find((p) => p.channel === 'sortKey');
    this.#sortKeys.clear();
  }

  #zoomOrZero(): number {
    return Number.isNaN(this.#zoom) ? 0 : this.#zoom;
  }

  #applyUniforms(zoom: number): void {
    const { context, handle } = this;
    if (context === undefined || handle === undefined) return;
    for (const property of this.#uniforms) {
      if (isStringChannel(property.channel) || property.channel === 'sortKey') continue;
      const value = new Float64Array(ATTRIBUTE_COMPONENTS[property.channel]);
      evaluateProperty(property, zoom, undefined, value, 0);
      this.#uniformValues.set(property.channel, value);
      context.target.setUniform(handle, property.channel, value);
    }
    for (const property of this.#perFeature) {
      if (!isStringChannel(property.channel) && property.channel !== 'sortKey') {
        context.target.setUniform(handle, property.channel, undefined);
      }
    }
  }

  #styleFeature(
    index: number,
    type?: string,
  ): { id: FeatureId | undefined; type: string; properties: Readonly<Record<string, unknown>> } {
    return {
      id: this.store.idAt(index),
      type: type ?? this.#geometryType(index),
      properties: this.store.propertiesAt(index),
    };
  }

  /** A feature's geometry for the renderer: circles from a center and their radii (F356), others as given. */
  #geometryOf(
    geometry: Geometry,
    properties: Readonly<Record<string, unknown>> | null | undefined,
  ): FeatureGeometry | undefined {
    if (this.kind === 'circle' && geometry.type === 'Point')
      return ellipseGeometry(geometry.coordinates, properties ?? {});
    // Vertices without their own height take the layer's absolute altitude (F362), as anchors do.
    const altitude = typeof this.placement === 'object' ? this.placement.absoluteAltitudeMeters : undefined;
    return toFeatureGeometry(altitude === undefined ? geometry : (atAltitude(geometry, altitude) as Geometry));
  }

  #geometryType(index: number): string {
    const geometry = this.store.geometryAt(index);
    if (geometry === undefined) return 'Point';
    return geometry.polygonStarts === undefined ? 'LineString' : 'Polygon';
  }

  #evaluate(index: number, zoom: number, type?: string): void {
    this.stats.featureEvaluations += 1;
    const feature = this.#styleFeature(index, type);
    const id = this.store.idAt(index);
    const state = id === undefined ? undefined : this.#states.get(id);
    for (const property of this.#perFeature) {
      const text = evaluateProperty(property, zoom, feature, scratch, 0, state);
      if (isStringChannel(property.channel)) this.store.setString(property.channel, index, text ?? '');
      else this.store.set(property.channel as BatchAttribute, index, scratch);
    }
    if (this.#sortKey !== undefined && id !== undefined) {
      evaluateProperty(this.#sortKey, zoom, feature, scratch, 0, state);
      this.#sortKeys.set(id, Number.isFinite(scratch[0]) ? (scratch[0] as number) : 0);
    }
  }

  #evaluateAll(zoom: number): void {
    this.stats.fullEvaluations += 1;
    for (let i = 0; i < this.store.count; i++) this.#evaluate(i, zoom);
  }

  #writeAnchor(index: number, position: readonly number[]): void {
    writePosition(position, scratch, 0);
    if (position[2] === undefined && typeof this.placement === 'object')
      scratch[2] = this.placement.absoluteAltitudeMeters;
    this.store.set('position', index, scratch);
  }

  #writeIdentity(index: number): void {
    this.store.setScalar('pickId', index, this.#slot === 0 ? 0 : packPickId(this.#slot, index));
    this.writeVisibility(index, this.featureVisibility(index));
  }
}

/** Coordinates with `heightMeters` added where a position has none. */
function atAltitude(value: unknown, heightMeters: number): unknown {
  if (!Array.isArray(value)) {
    const geometry = value as { coordinates?: unknown };
    return { ...geometry, coordinates: atAltitude(geometry.coordinates, heightMeters) };
  }
  if (typeof value[0] === 'number') return value.length >= 3 ? value : [value[0], value[1], heightMeters];
  return value.map((item: unknown) => atAltitude(item, heightMeters));
}
