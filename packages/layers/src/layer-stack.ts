/**
 * The stack of data layers (`globe.layers` in docs/plan/api.md): add, remove, reorder, show and hide at runtime, with
 * every change applied on the next frame. The stack owns the pick-slot table, so a picked id resolves to its layer
 * and feature (ADR 0029).
 */
import type { FrameContext, Layer, LayerContext, PickedFeature } from './layer.js';
import { PickSlotTable, pickFeatureIndex } from './picking.js';
import type { LayerRenderTarget } from './render-target.js';

interface Entry {
  readonly layer: Layer;
  readonly slots: Set<number>;
  visible: boolean;
}

interface SlotOwner {
  readonly layer: Layer;
  readonly resolve: (featureIndex: number) => PickedFeature | undefined;
}

/** Where a layer goes: on top (default), at an index from the bottom, or directly above or below another layer. */
export type LayerPosition = { readonly index: number } | { readonly above: string } | { readonly below: string };

/** The ordered set of layers of one globe. */
export class LayerStack {
  readonly #target: LayerRenderTarget;
  readonly #entries: Entry[] = [];
  readonly #slots = new PickSlotTable<SlotOwner>();

  constructor(target: LayerRenderTarget) {
    this.#target = target;
  }

  /** Layer ids from bottom to top. */
  get order(): readonly string[] {
    return this.#entries.map((e) => e.layer.id);
  }

  /** Number of layers. */
  get size(): number {
    return this.#entries.length;
  }

  /**
   * Adds a layer, on top unless a position is given.
   * @returns the layer, for chaining.
   * @throws Error when a layer with the same id is already in the stack.
   */
  add<T extends Layer>(layer: T, position?: LayerPosition): T {
    if (this.#find(layer.id) >= 0) throw new Error(`a layer with id ${layer.id} is already in the stack`);
    const entry: Entry = { layer, slots: new Set(), visible: true };
    const context: LayerContext = {
      target: this.#target,
      acquirePickSlot: (resolve) => {
        const slot = this.#slots.acquire({ layer, resolve });
        entry.slots.add(slot);
        return slot;
      },
      releasePickSlot: (slot) => {
        if (entry.slots.delete(slot)) this.#slots.release(slot);
      },
    };
    this.#entries.splice(position === undefined ? this.#entries.length : this.#resolve(position), 0, entry);
    layer.attach(context);
    this.#renumber();
    return layer;
  }

  /**
   * Removes a layer and frees everything it holds.
   * @returns false when it was not in the stack.
   */
  remove(layerOrId: Layer | string): boolean {
    const index = this.#find(typeof layerOrId === 'string' ? layerOrId : layerOrId.id);
    if (index < 0) return false;
    const [entry] = this.#entries.splice(index, 1) as [Entry];
    entry.layer.detach();
    for (const slot of entry.slots) this.#slots.release(slot);
    entry.slots.clear();
    this.#renumber();
    return true;
  }

  /** Moves a layer to a new position. */
  move(id: string, position: LayerPosition): void {
    const index = this.#find(id);
    if (index < 0) throw new Error(`no layer ${id}`);
    const [entry] = this.#entries.splice(index, 1) as [Entry];
    try {
      this.#entries.splice(this.#resolve(position), 0, entry);
    } catch (error) {
      this.#entries.splice(index, 0, entry);
      throw error;
    }
    this.#renumber();
  }

  /** Shows or hides a layer. */
  setVisible(id: string, visible: boolean): void {
    const entry = this.#entries[this.#find(id)];
    if (entry === undefined) throw new Error(`no layer ${id}`);
    entry.visible = visible;
    entry.layer.setVisible(visible);
  }

  /** Whether a layer is shown. */
  isVisible(id: string): boolean {
    return this.#entries[this.#find(id)]?.visible ?? false;
  }

  /** The layer with an id. */
  get(id: string): Layer | undefined {
    return this.#entries[this.#find(id)]?.layer;
  }

  /** Runs every layer's frame step, bottom to top; the engine calls this once per frame before drawing. */
  frame(frame: FrameContext): void {
    for (const entry of this.#entries) entry.layer.frame(frame);
  }

  /** Maps an id read from the id buffer to its layer and feature; undefined for 0 or a slot no longer in use. */
  resolvePick(id: number): { layer: Layer; feature: PickedFeature } | undefined {
    if (id === 0) return undefined;
    const owner = this.#slots.owner(id);
    if (owner === undefined) return undefined;
    const feature = owner.resolve(pickFeatureIndex(id));
    return feature === undefined ? undefined : { layer: owner.layer, feature };
  }

  /** Removes every layer. */
  clear(): void {
    while (this.#entries.length > 0) this.remove((this.#entries[this.#entries.length - 1] as Entry).layer);
  }

  #find(id: string): number {
    return this.#entries.findIndex((e) => e.layer.id === id);
  }

  #resolve(position: LayerPosition): number {
    if ('index' in position) return Math.max(0, Math.min(this.#entries.length, Math.trunc(position.index)));
    const reference = 'above' in position ? position.above : position.below;
    const index = this.#find(reference);
    if (index < 0) throw new Error(`no layer ${reference}`);
    return 'above' in position ? index + 1 : index;
  }

  #renumber(): void {
    this.#entries.forEach((entry, i) => entry.layer.setOrder(i));
  }
}
