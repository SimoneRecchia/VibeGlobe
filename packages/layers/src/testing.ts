// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * @packageDocumentation
 * Test helpers of the layers package: {@link RecordingRenderTarget}, a `LayerRenderTarget` that records every upload
 * instead of drawing, for unit tests of layers (the package's own, and custom layers', F388).
 * @module @vibeglobe/layers/testing
 */
import { ATTRIBUTE_COMPONENTS } from '@vibeglobe/core';
import type {
  BatchAttribute,
  BatchDescriptor,
  BatchHandle,
  BatchStringChannel,
  FeatureGeometry,
  LayerRenderTarget,
} from '@vibeglobe/core';

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

  /** See {@link LayerRenderTarget}. */
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

  /** See {@link LayerRenderTarget}. */
  growBatch(handle: BatchHandle, capacity: number): void {
    const batch = this.#get(handle);
    for (const [attribute, values] of batch.attributes) {
      const grown = new Float64Array(capacity * ATTRIBUTE_COMPONENTS[attribute]);
      grown.set(values);
      batch.attributes.set(attribute, grown);
    }
    batch.capacity = capacity;
  }

  /** See {@link LayerRenderTarget}. */
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

  /** See {@link LayerRenderTarget}. */
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

  /** See {@link LayerRenderTarget}. */
  writeGeometry(handle: BatchHandle, feature: number, geometry: FeatureGeometry): void {
    this.#get(handle).geometry.set(feature, geometry);
    this.stringWrites.push({ batch: handle.id, channel: 'geometry', first: feature, count: 1 });
  }

  /** See {@link LayerRenderTarget}. */
  setUniform(handle: BatchHandle, attribute: BatchAttribute, value: Float64Array | undefined): void {
    const batch = this.#get(handle);
    if (value === undefined) batch.uniforms.delete(attribute);
    else batch.uniforms.set(attribute, Float64Array.from(value));
  }

  /** See {@link LayerRenderTarget}. */
  setCount(handle: BatchHandle, count: number): void {
    this.#get(handle).count = count;
  }

  /** See {@link LayerRenderTarget}. */
  setOrder(handle: BatchHandle, order: number): void {
    this.#get(handle).order = order;
  }

  /** Shows or hides the whole batch. */
  setVisible(handle: BatchHandle, visible: boolean): void {
    this.#get(handle).visible = visible;
  }

  /** See {@link LayerRenderTarget}. */
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
