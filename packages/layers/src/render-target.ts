/**
 * The small typed interface through which data layers draw (docs/parallel-tracks.md, "Data layers track"). The layers
 * package owns the feature data and decides what changed; the renderer owns GPU buffers and draws them. The main
 * session implements this interface in `@vibeglobe/renderer`; until then tests use {@link RecordingRenderTarget}.
 */
import type { GeoPosition, ScreenPoint } from '@vibeglobe/core';

/** Primitive families a batch can hold. */
export type BatchKind = 'point' | 'marker' | 'label' | 'polyline' | 'polygon' | 'circle';

/**
 * Numeric per-feature attributes of a batch, stored structure-of-arrays (ADR 0029). Components per feature are in
 * {@link ATTRIBUTE_COMPONENTS}: `position` holds longitude and latitude in degrees and height in meters (float64);
 * colors are straight (not premultiplied) RGBA in 0–1; `anchor` is an index into
 * {@link ANCHORS}; `visible` is a visibility factor in 0–1 (0 hidden, 1 shown, between while a label fades); `pickId` is the packed id of picking.ts.
 */
export type BatchAttribute =
  | 'position'
  | 'color'
  | 'outlineColor'
  | 'sizePx'
  | 'widthPx'
  | 'opacity'
  | 'rotationDeg'
  | 'offsetPx'
  | 'heightMeters'
  | 'baseMeters'
  | 'anchor'
  | 'visible'
  | 'pickId';

/** Components per feature of each attribute. */
export const ATTRIBUTE_COMPONENTS: Readonly<Record<BatchAttribute, number>> = {
  position: 3,
  color: 4,
  outlineColor: 4,
  sizePx: 1,
  widthPx: 1,
  opacity: 1,
  rotationDeg: 1,
  offsetPx: 2,
  heightMeters: 1,
  baseMeters: 1,
  anchor: 1,
  visible: 1,
  pickId: 1,
};

/** Anchors of labels and markers (MapLibre `text-anchor` and `icon-anchor`), in the order the `anchor` attribute indexes. */
export const ANCHORS = [
  'center',
  'left',
  'right',
  'top',
  'bottom',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
] as const;

/** Every numeric attribute, in a fixed order (the bit order of the store's dirty flags). */
export const BATCH_ATTRIBUTES = Object.keys(ATTRIBUTE_COMPONENTS) as readonly BatchAttribute[];

/** Per-feature text channels: a label's text and a marker's icon name (the renderer lays out glyphs and atlases icons). */
export type BatchStringChannel = 'text' | 'icon';

/** Line and polygon geometry of one feature: flat `[lon, lat, height, ...]` vertices and the start of each part. */
export interface FeatureGeometry {
  readonly positions: Float64Array;
  /** Vertex index where each line or ring starts; polygons list the outer ring first, then holes. */
  readonly partStarts: Uint32Array;
  /** For polygons: index into `partStarts` where each polygon starts (multi-polygons have several). */
  readonly polygonStarts?: Uint32Array;
}

/** How features are placed in height (PLAN.md, Data layers: placement). */
export type Placement = 'clamp-to-ground' | 'drape' | { readonly absoluteAltitudeMeters: number };

/** What the renderer needs to allocate a batch. */
export interface BatchDescriptor {
  readonly kind: BatchKind;
  /** Owning layer id, for diagnostics. */
  readonly layerId: string;
  /** Features the buffers hold before they must grow. */
  readonly capacity: number;
  readonly placement: Placement;
}

/** An opaque handle to a renderer-side batch. */
export interface BatchHandle {
  readonly id: number;
}

/** The draw interface data layers use; every call takes effect on the next frame. */
export interface LayerRenderTarget {
  /** Allocates GPU buffers for a batch. */
  createBatch(descriptor: BatchDescriptor): BatchHandle;
  /** Reallocates a batch for a larger capacity, keeping its contents (not a rebuild: no data is re-uploaded). */
  growBatch(handle: BatchHandle, capacity: number): void;
  /**
   * Uploads features `[first, first + count)` of one attribute; `data` holds the whole attribute array (the renderer
   * reads only the range, so a single-feature change uploads one feature).
   */
  writeRange(
    handle: BatchHandle,
    attribute: BatchAttribute,
    first: number,
    count: number,
    data: Float64Array | Float32Array | Uint32Array,
  ): void;
  /** Uploads text or icon names of features `[first, first + count)`; `values` holds the whole channel. */
  writeStrings(
    handle: BatchHandle,
    channel: BatchStringChannel,
    first: number,
    count: number,
    values: readonly string[],
  ): void;
  /** Sets the line or polygon geometry of one feature (lines and polygons only). */
  writeGeometry(handle: BatchHandle, feature: number, geometry: FeatureGeometry): void;
  /**
   * Overrides an attribute for every feature of the batch with one value (zoom-only style expressions, evaluated once
   * per frame); `undefined` returns to the per-feature values.
   */
  setUniform(handle: BatchHandle, attribute: BatchAttribute, value: Float64Array | undefined): void;
  /** Number of features the renderer draws, from index 0. */
  setCount(handle: BatchHandle, count: number): void;
  /** Draw order of batches: lower first, so higher values draw on top. */
  setOrder(handle: BatchHandle, order: number): void;
  /** Shows or hides the whole batch. */
  setVisible(handle: BatchHandle, visible: boolean): void;
  /** Frees the batch's GPU buffers. */
  release(handle: BatchHandle): void;
}

/** Projection of geographic positions to the screen for the frame being drawn (label placement, clusters). */
export interface ScreenProjector {
  /** Screen point of a position, or undefined when it is behind the globe or outside the view. */
  geoToScreen(position: GeoPosition): ScreenPoint | undefined;
  /** The current zoom (Web Mercator zoom, continuous). */
  zoom(): number;
}

/** Size of a laid-out text, from the renderer's glyph metrics (label collision boxes). */
export interface TextMeasurer {
  measure(text: string, sizePx: number): { readonly widthPx: number; readonly heightPx: number };
}

/**
 * A stand-in measurer until the renderer exposes its glyph metrics (docs/parallel-tracks.md, hook request): 0.6 em per
 * character, 1.2 em high.
 */
export const estimatedTextMeasurer: TextMeasurer = {
  measure: (text, sizePx) => ({ widthPx: [...text].length * 0.6 * sizePx, heightPx: 1.2 * sizePx }),
};

/** One recorded upload, for instrumentation. */
export interface RecordedWrite {
  readonly batch: number;
  readonly attribute: BatchAttribute;
  readonly first: number;
  readonly count: number;
}

interface RecordedBatch {
  readonly descriptor: BatchDescriptor;
  capacity: number;
  count: number;
  order: number;
  visible: boolean;
  readonly attributes: Map<BatchAttribute, Float64Array>;
  readonly strings: Map<BatchStringChannel, string[]>;
  readonly geometry: Map<number, FeatureGeometry>;
  readonly uniforms: Map<BatchAttribute, Float64Array>;
}

/**
 * A render target that keeps copies of what was uploaded and counts every call: the test double for the renderer and
 * the instrumentation behind "only the changed range is uploaded" (F376, F377).
 */
export class RecordingRenderTarget implements LayerRenderTarget {
  /** Every string and geometry upload since the last {@link RecordingRenderTarget.clearWrites}. */
  readonly stringWrites: { batch: number; channel: BatchStringChannel | 'geometry'; first: number; count: number }[] =
    [];
  /** Every upload since the last {@link RecordingRenderTarget.clearWrites}. */
  readonly writes: RecordedWrite[] = [];
  /** Batches created and released over the target's life. */
  created = 0;
  released = 0;
  readonly #batches = new Map<number, RecordedBatch>();
  #nextId = 1;

  createBatch(descriptor: BatchDescriptor): BatchHandle {
    const id = this.#nextId++;
    this.#batches.set(id, {
      descriptor,
      capacity: descriptor.capacity,
      count: 0,
      order: 0,
      visible: true,
      attributes: new Map(),
      strings: new Map(),
      geometry: new Map(),
      uniforms: new Map(),
    });
    this.created += 1;
    return { id };
  }

  growBatch(handle: BatchHandle, capacity: number): void {
    const batch = this.#get(handle);
    for (const [attribute, values] of batch.attributes) {
      const grown = new Float64Array(capacity * ATTRIBUTE_COMPONENTS[attribute]);
      grown.set(values);
      batch.attributes.set(attribute, grown);
    }
    batch.capacity = capacity;
  }

  writeRange(
    handle: BatchHandle,
    attribute: BatchAttribute,
    first: number,
    count: number,
    data: Float64Array | Float32Array | Uint32Array,
  ): void {
    const batch = this.#get(handle);
    const components = ATTRIBUTE_COMPONENTS[attribute];
    if (first < 0 || first + count > batch.capacity) throw new RangeError(`write past capacity ${batch.capacity}`);
    let values = batch.attributes.get(attribute);
    if (values === undefined) {
      values = new Float64Array(batch.capacity * components);
      batch.attributes.set(attribute, values);
    }
    values.set(data.subarray(first * components, (first + count) * components), first * components);
    this.writes.push({ batch: handle.id, attribute, first, count });
  }

  writeStrings(
    handle: BatchHandle,
    channel: BatchStringChannel,
    first: number,
    count: number,
    values: readonly string[],
  ): void {
    const batch = this.#get(handle);
    if (first < 0 || first + count > batch.capacity) throw new RangeError(`write past capacity ${batch.capacity}`);
    let stored = batch.strings.get(channel);
    if (stored === undefined) {
      stored = [];
      batch.strings.set(channel, stored);
    }
    for (let i = first; i < first + count; i++) stored[i] = values[i] ?? '';
    this.stringWrites.push({ batch: handle.id, channel, first, count });
  }

  writeGeometry(handle: BatchHandle, feature: number, geometry: FeatureGeometry): void {
    this.#get(handle).geometry.set(feature, geometry);
    this.stringWrites.push({ batch: handle.id, channel: 'geometry', first: feature, count: 1 });
  }

  setUniform(handle: BatchHandle, attribute: BatchAttribute, value: Float64Array | undefined): void {
    const batch = this.#get(handle);
    if (value === undefined) batch.uniforms.delete(attribute);
    else batch.uniforms.set(attribute, Float64Array.from(value));
  }

  setCount(handle: BatchHandle, count: number): void {
    this.#get(handle).count = count;
  }

  setOrder(handle: BatchHandle, order: number): void {
    this.#get(handle).order = order;
  }

  /** Shows or hides the whole batch. */
  setVisible(handle: BatchHandle, visible: boolean): void {
    this.#get(handle).visible = visible;
  }

  release(handle: BatchHandle): void {
    this.#get(handle);
    this.#batches.delete(handle.id);
    this.released += 1;
  }

  /** Forgets the recorded uploads. */
  clearWrites(): void {
    this.writes.length = 0;
    this.stringWrites.length = 0;
  }

  /** Batches currently held. */
  get liveBatches(): number {
    return this.#batches.size;
  }

  /** The uploaded value of one feature's attribute (component `component`). */
  value(handle: BatchHandle, attribute: BatchAttribute, feature: number, component = 0): number | undefined {
    return this.#get(handle).attributes.get(attribute)?.[feature * ATTRIBUTE_COMPONENTS[attribute] + component];
  }

  /** The uploaded string of one feature. */
  string(handle: BatchHandle, channel: BatchStringChannel, feature: number): string | undefined {
    return this.#get(handle).strings.get(channel)?.[feature];
  }

  /** The uploaded geometry of one feature. */
  geometry(handle: BatchHandle, feature: number): FeatureGeometry | undefined {
    return this.#get(handle).geometry.get(feature);
  }

  /** The uniform override of an attribute, if set. */
  uniform(handle: BatchHandle, attribute: BatchAttribute): Float64Array | undefined {
    return this.#get(handle).uniforms.get(attribute);
  }

  /** Draw state of a batch. */
  state(handle: BatchHandle): { count: number; order: number; visible: boolean; capacity: number } {
    const { count, order, visible, capacity } = this.#get(handle);
    return { count, order, visible, capacity };
  }

  #get(handle: BatchHandle): RecordedBatch {
    const batch = this.#batches.get(handle.id);
    if (batch === undefined) throw new Error(`unknown or released batch ${handle.id}`);
    return batch;
  }
}
