// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * A label layer (F357, F359, F360): text at coordinates, styled with MapLibre `text-*` properties, decluttered by
 * {@link LabelPlacer} with fades. Glyph rendering (SDF atlases) is the renderer's; this layer decides what shows.
 */
import { DataLayer, type DataLayerOptions } from './data-layer.js';
import type { FrameContext, LayerContext } from './layer.js';
import { LabelPlacer, type CollisionBox, type PlacementInput, type PlacementOptions } from './label-placement.js';
import { estimatedTextMeasurer, type TextMeasurer } from './render-target.js';
import type { FeatureId } from './feature-store.js';

/** Options of a label layer. */
export interface LabelLayerOptions extends DataLayerOptions {
  /**
   * Text sizes for collision boxes. By default the renderer's glyph metrics, when the render target measures text,
   * otherwise {@link estimatedTextMeasurer}.
   */
  readonly measurer?: TextMeasurer;
  /** Placement interval, fade duration and padding. */
  readonly collision?: PlacementOptions;
}

/** Labels with collision and priorities. */
export class LabelLayer extends DataLayer {
  readonly placer: LabelPlacer;
  readonly #ownMeasurer: boolean;

  constructor(options: LabelLayerOptions = {}) {
    super('label', options);
    this.#ownMeasurer = options.measurer !== undefined;
    this.placer = new LabelPlacer(options.measurer ?? estimatedTextMeasurer, options.collision);
  }

  /** Attaches, measuring collision boxes with the renderer's glyph metrics unless a measurer was given (F359). */
  override attach(context: LayerContext): void {
    const target = context.target;
    if (!this.#ownMeasurer && target.measureText)
      this.placer.setMeasurer({
        measure: (text, sizePx) => target.measureText?.(text, sizePx) ?? estimatedTextMeasurer.measure(text, sizePx),
      });
    super.attach(context);
  }

  /** Boxes of the last placement pass (debug collision overlay, F359). */
  get collisionBoxes(): readonly CollisionBox[] {
    return this.placer.collisionBoxes;
  }

  /** Whether the last placement pass kept a label. */
  isPlaced(id: FeatureId): boolean {
    return this.placer.isPlaced(id);
  }

  /** Removes a label and forgets its placement. */
  override removeFeature(id: FeatureId): boolean {
    const removed = super.removeFeature(id);
    if (removed) this.placer.forget(id);
    return removed;
  }

  protected override beforeFlush(frame: FrameContext): void {
    if (this.store.count !== this.#placedCount) {
      this.placer.invalidate();
      this.#placedCount = this.store.count;
    }
    this.placer.update(frame.nowMs, frame.projector, () => this.#inputs());
    // A sliced pass, or a view that changed since the last one, needs more frames: the globe draws only when asked.
    if (this.placer.pending) this.context?.requestFrame();
    for (let i = 0; i < this.store.count; i++) {
      const id = this.store.idAt(i);
      if (id !== undefined) this.writeVisibility(i, this.placer.opacity(id));
    }
  }

  #placedCount = -1;

  /** One mutable input and one iterator result, refilled for each label (KB-171): the placer copies what it reads. */
  readonly #input = {
    id: 0 as FeatureId,
    longitudeDeg: 0,
    latitudeDeg: 0,
    heightMeters: 0,
    text: '',
    sizePx: 0,
    anchor: 0,
    offsetXEm: 0,
    offsetYEm: 0,
    sortKey: 0,
    enabled: false,
  };
  readonly #result: { done: boolean; value: PlacementInput } = { done: false, value: this.#input };

  /** The labels as placement reads them, each valid until the next is read; every call reads from the first. */
  #inputs(): Iterable<PlacementInput> {
    const cursor = { index: 0 };
    const iterator: IterableIterator<PlacementInput> = {
      next: () => this.#nextInput(cursor),
      [Symbol.iterator]: () => iterator,
    };
    return iterator;
  }

  #nextInput(cursor: { index: number }): IteratorResult<PlacementInput> {
    const p = this.store.array('position');
    for (; cursor.index < this.store.count; cursor.index++) {
      const i = cursor.index;
      const id = this.store.idAt(i);
      if (id === undefined) continue;
      const input = this.#input;
      input.id = id;
      input.longitudeDeg = p[3 * i] ?? 0;
      input.latitudeDeg = p[3 * i + 1] ?? 0;
      input.heightMeters = p[3 * i + 2] ?? 0;
      input.text = this.store.stringAt('text', i);
      input.sizePx = this.attributeValue('sizePx', i, 0);
      input.anchor = this.attributeValue('anchor', i, 0);
      input.offsetXEm = this.attributeValue('offsetPx', i, 0);
      input.offsetYEm = this.attributeValue('offsetPx', i, 1);
      input.sortKey = this.sortKey(i);
      input.enabled = this.featureVisibility(i) > 0;
      cursor.index++;
      this.#result.done = false;
      return this.#result;
    }
    this.#result.done = true;
    return this.#result;
  }
}
