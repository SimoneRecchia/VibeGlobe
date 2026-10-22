/**
 * A label layer (F357, F359, F360): text at coordinates, styled with MapLibre `text-*` properties, decluttered by
 * {@link LabelPlacer} with fades. Glyph rendering (SDF atlases) is the renderer's; this layer decides what shows.
 */
import { DataLayer, type DataLayerOptions } from './data-layer.js';
import type { FrameContext } from './layer.js';
import { LabelPlacer, type CollisionBox, type PlacementInput, type PlacementOptions } from './label-placement.js';
import { estimatedTextMeasurer, type TextMeasurer } from './render-target.js';
import type { FeatureId } from './feature-store.js';

/** Options of a label layer. */
export interface LabelLayerOptions extends DataLayerOptions {
  /** Glyph metrics for collision boxes; the renderer's measurer once it exists (docs/parallel-tracks.md). */
  readonly measurer?: TextMeasurer;
  /** Placement interval, fade duration and padding. */
  readonly collision?: PlacementOptions;
}

/** Labels with collision and priorities. */
export class LabelLayer extends DataLayer {
  readonly placer: LabelPlacer;

  constructor(options: LabelLayerOptions = {}) {
    super('label', options);
    this.placer = new LabelPlacer(options.measurer ?? estimatedTextMeasurer, options.collision);
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
    for (let i = 0; i < this.store.count; i++) {
      const id = this.store.idAt(i);
      if (id !== undefined) this.writeVisibility(i, this.placer.opacity(id));
    }
  }

  #placedCount = -1;

  *#inputs(): Generator<PlacementInput> {
    const p = this.store.array('position');
    for (let i = 0; i < this.store.count; i++) {
      const id = this.store.idAt(i);
      if (id === undefined) continue;
      yield {
        id,
        longitudeDeg: p[3 * i] ?? 0,
        latitudeDeg: p[3 * i + 1] ?? 0,
        heightMeters: p[3 * i + 2] ?? 0,
        text: this.store.stringAt('text', i),
        sizePx: this.attributeValue('sizePx', i, 0),
        anchor: this.attributeValue('anchor', i, 0),
        offsetXEm: this.attributeValue('offsetPx', i, 0),
        offsetYEm: this.attributeValue('offsetPx', i, 1),
        sortKey: this.sortKey(i),
        enabled: this.featureVisibility(i) > 0,
      };
    }
  }
}
