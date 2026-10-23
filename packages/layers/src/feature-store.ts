/**
 * Structure-of-arrays storage of a layer's features with per-feature dirty flags (ADR 0029). A change to one feature
 * marks only that feature's attributes, and {@link FeatureStore.flush} uploads the changed features as contiguous runs,
 * so a single-feature update never re-uploads the layer (F376, F377).
 */
import {
  ATTRIBUTE_COMPONENTS,
  BATCH_ATTRIBUTES,
  type BatchAttribute,
  type BatchHandle,
  type BatchStringChannel,
  type FeatureGeometry,
  type LayerRenderTarget,
} from './render-target.js';

/** Application feature ids. */
export type FeatureId = string | number;

const STRING_CHANNELS: readonly BatchStringChannel[] = ['text', 'icon'];
const STRING_BIT: Readonly<Record<BatchStringChannel, number>> = {
  text: 1 << BATCH_ATTRIBUTES.length,
  icon: 1 << (BATCH_ATTRIBUTES.length + 1),
};
const GEOMETRY_BIT = 1 << (BATCH_ATTRIBUTES.length + 2);
const ATTRIBUTE_BIT = Object.fromEntries(BATCH_ATTRIBUTES.map((name, i) => [name, 1 << i])) as Record<
  BatchAttribute,
  number
>;

function allocate(attribute: BatchAttribute, capacity: number): Float64Array | Float32Array | Uint32Array {
  const length = capacity * ATTRIBUTE_COMPONENTS[attribute];
  if (attribute === 'position') return new Float64Array(length);
  if (attribute === 'pickId') return new Uint32Array(length);
  return new Float32Array(length);
}

/** A layer's features: ids, properties and every attribute, indexed 0…count−1 without holes. */
export class FeatureStore {
  #capacity: number;
  #count = 0;
  readonly #ids: FeatureId[] = [];
  readonly #index = new Map<FeatureId, number>();
  readonly #properties: Record<string, unknown>[] = [];
  readonly #geometry: (FeatureGeometry | undefined)[] = [];
  readonly #strings: Record<BatchStringChannel, string[]> = { text: [], icon: [] };
  #arrays: Record<BatchAttribute, Float64Array | Float32Array | Uint32Array>;
  #dirty: Uint32Array;
  #dirtyMin = Infinity;
  #dirtyMax = -1;
  /** Called when the store goes from clean to dirty: the host draws a frame, which flushes it. */
  onDirty: (() => void) | undefined;
  /** Count the renderer last received. */
  #flushedCount = 0;
  /** Capacity the renderer last received. */
  #flushedCapacity: number;

  constructor(initialCapacity = 64) {
    this.#capacity = Math.max(1, initialCapacity);
    this.#flushedCapacity = this.#capacity;
    this.#arrays = Object.fromEntries(BATCH_ATTRIBUTES.map((a) => [a, allocate(a, this.#capacity)])) as Record<
      BatchAttribute,
      Float64Array | Float32Array | Uint32Array
    >;
    this.#dirty = new Uint32Array(this.#capacity);
  }

  /** Number of features. */
  get count(): number {
    return this.#count;
  }

  /** Allocated features. */
  get capacity(): number {
    return this.#capacity;
  }

  /** The index of a feature, or undefined. */
  indexOf(id: FeatureId): number | undefined {
    return this.#index.get(id);
  }

  /** The id of the feature at an index. */
  idAt(index: number): FeatureId | undefined {
    return index < this.#count ? this.#ids[index] : undefined;
  }

  /** The properties of the feature at an index. */
  propertiesAt(index: number): Readonly<Record<string, unknown>> {
    return this.#properties[index] ?? {};
  }

  /** The geometry of the feature at an index, for lines and polygons. */
  geometryAt(index: number): FeatureGeometry | undefined {
    return this.#geometry[index];
  }

  /** The raw array of an attribute (read it; write through {@link FeatureStore.set}). */
  array(attribute: BatchAttribute): Float64Array | Float32Array | Uint32Array {
    return this.#arrays[attribute];
  }

  /** A string channel's value at an index. */
  stringAt(channel: BatchStringChannel, index: number): string {
    return this.#strings[channel][index] ?? '';
  }

  /**
   * Appends a feature.
   * @throws Error when the id is already present.
   */
  add(id: FeatureId, properties: Record<string, unknown>, geometry?: FeatureGeometry): number {
    if (this.#index.has(id)) throw new Error(`duplicate feature id ${String(id)}`);
    if (this.#count === this.#capacity) this.#grow(this.#capacity * 2);
    const index = this.#count++;
    this.#ids[index] = id;
    this.#index.set(id, index);
    this.#properties[index] = properties;
    this.#geometry[index] = geometry;
    this.#mark(index, ~0 >>> 0);
    return index;
  }

  /**
   * Removes a feature by moving the last feature into its place (one feature re-uploaded, no hole).
   * @returns the index whose feature changed (the moved one), or undefined when the id was unknown.
   */
  remove(id: FeatureId): number | undefined {
    const index = this.#index.get(id);
    if (index === undefined) return undefined;
    const last = this.#count - 1;
    this.#index.delete(id);
    if (index !== last) {
      const moved = this.#ids[last] as FeatureId;
      this.#ids[index] = moved;
      this.#index.set(moved, index);
      this.#properties[index] = this.#properties[last] ?? {};
      this.#geometry[index] = this.#geometry[last];
      for (const channel of STRING_CHANNELS) this.#strings[channel][index] = this.#strings[channel][last] ?? '';
      for (const attribute of BATCH_ATTRIBUTES) {
        const components = ATTRIBUTE_COMPONENTS[attribute];
        const array = this.#arrays[attribute];
        array.copyWithin(index * components, last * components, (last + 1) * components);
      }
      this.#mark(index, ~0 >>> 0);
    }
    this.#ids.length = last;
    this.#properties.length = last;
    this.#geometry.length = last;
    this.#dirty[last] = 0;
    this.#count = last;
    return index === last ? undefined : index;
  }

  /** Replaces a feature's properties (the caller re-evaluates its style). */
  setProperties(index: number, properties: Record<string, unknown>): void {
    this.#properties[index] = properties;
  }

  /** Replaces a feature's geometry. */
  setGeometry(index: number, geometry: FeatureGeometry): void {
    this.#geometry[index] = geometry;
    this.#mark(index, GEOMETRY_BIT);
  }

  /** Writes components of one attribute of one feature; marks it dirty only when a value changed. */
  set(attribute: BatchAttribute, index: number, values: ArrayLike<number>, first = 0): void {
    const components = ATTRIBUTE_COMPONENTS[attribute];
    const array = this.#arrays[attribute];
    const base = index * components;
    let changed = false;
    for (let c = 0; c < components; c++) {
      const stored = array[base + c];
      array[base + c] = values[first + c] ?? 0;
      if (array[base + c] !== stored) changed = true;
    }
    if (changed) this.#mark(index, ATTRIBUTE_BIT[attribute]);
  }

  /** Writes one component (scalar attributes). */
  setScalar(attribute: BatchAttribute, index: number, value: number): void {
    const array = this.#arrays[attribute];
    const at = index * ATTRIBUTE_COMPONENTS[attribute];
    const stored = array[at];
    array[at] = value;
    if (array[at] === stored) return;
    this.#mark(index, ATTRIBUTE_BIT[attribute]);
  }

  /** Writes a string channel value. */
  setString(channel: BatchStringChannel, index: number, value: string): void {
    if (this.#strings[channel][index] === value) return;
    this.#strings[channel][index] = value;
    this.#mark(index, STRING_BIT[channel]);
  }

  /** True when some feature changed since the last flush. */
  get dirty(): boolean {
    return this.#dirtyMax >= 0 || this.#count !== this.#flushedCount || this.#capacity !== this.#flushedCapacity;
  }

  /** Uploads every change since the last flush as contiguous runs per attribute, then clears the flags. */
  flush(target: LayerRenderTarget, handle: BatchHandle): void {
    if (this.#capacity !== this.#flushedCapacity) {
      target.growBatch(handle, this.#capacity);
      this.#flushedCapacity = this.#capacity;
    }
    if (this.#dirtyMax >= 0) {
      for (const attribute of BATCH_ATTRIBUTES) {
        this.#flushRuns(ATTRIBUTE_BIT[attribute], (first, count) => {
          target.writeRange(handle, attribute, first, count, this.#arrays[attribute]);
        });
      }
      for (const channel of STRING_CHANNELS) {
        this.#flushRuns(STRING_BIT[channel], (first, count) => {
          target.writeStrings(handle, channel, first, count, this.#strings[channel]);
        });
      }
      this.#flushRuns(GEOMETRY_BIT, (first, count) => {
        for (let i = first; i < first + count; i++) {
          const geometry = this.#geometry[i];
          if (geometry !== undefined) target.writeGeometry(handle, i, geometry);
        }
      });
      this.#dirty.fill(0, this.#dirtyMin, this.#dirtyMax + 1);
      this.#dirtyMin = Infinity;
      this.#dirtyMax = -1;
    }
    if (this.#count !== this.#flushedCount) {
      target.setCount(handle, this.#count);
      this.#flushedCount = this.#count;
    }
  }

  /** Marks every feature dirty again (for a fresh batch after the renderer recreated its resources). */
  markAllDirty(): void {
    this.#flushedCount = -1;
    this.#flushedCapacity = -1;
    for (let i = 0; i < this.#count; i++) this.#mark(i, ~0 >>> 0);
  }

  #flushRuns(bit: number, write: (first: number, count: number) => void): void {
    let runStart = -1;
    const end = Math.min(this.#dirtyMax, this.#count - 1);
    for (let i = this.#dirtyMin; i <= end + 1; i++) {
      const isDirty = i <= end && ((this.#dirty[i] ?? 0) & bit) !== 0;
      if (isDirty && runStart < 0) runStart = i;
      else if (!isDirty && runStart >= 0) {
        write(runStart, i - runStart);
        runStart = -1;
      }
    }
  }

  #mark(index: number, bits: number): void {
    if (this.#dirtyMax < 0) this.onDirty?.();
    this.#dirty[index] = ((this.#dirty[index] ?? 0) | bits) >>> 0;
    if (index < this.#dirtyMin) this.#dirtyMin = index;
    if (index > this.#dirtyMax) this.#dirtyMax = index;
  }

  #grow(capacity: number): void {
    for (const attribute of BATCH_ATTRIBUTES) {
      const grown = allocate(attribute, capacity);
      grown.set(this.#arrays[attribute]);
      this.#arrays[attribute] = grown;
    }
    const dirty = new Uint32Array(capacity);
    dirty.set(this.#dirty);
    this.#dirty = dirty;
    this.#capacity = capacity;
  }
}
