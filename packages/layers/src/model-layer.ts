/**
 * glTF models as data-layer features (`@vibeglobe/layers/models`), an entry of its own: applications that show no
 * models load none of it, as they load no glTF loader (`@vibeglobe/renderer/gltf`).
 * @packageDocumentation
 */
import type { GeoPosition, ModelPose, ModelRenderer } from '@vibeglobe/core';
import type { FeatureId } from './feature-store.js';
import { LayerEmitter, type Layer, type LayerContext, type PickedFeature } from './layer.js';
import { packPickId } from './picking.js';

/** A glTF model as a layer feature (F379–F382): its file, pose and properties. */
export interface ModelFeature {
  readonly id: FeatureId;
  /** The glTF file: its URL, or its bytes. */
  readonly url?: string;
  readonly data?: ArrayBuffer;
  readonly position: GeoPosition;
  readonly headingDeg?: number;
  readonly pitchDeg?: number;
  readonly rollDeg?: number;
  readonly scale?: number;
  readonly properties?: Readonly<Record<string, unknown>>;
}

/** Options of {@link ModelLayer}. */
export interface ModelLayerOptions {
  readonly id?: string;
  readonly models: readonly ModelFeature[];
  /** Models can be dragged to a new position (F382). */
  readonly draggable?: boolean;
  /** The blend toward a color of a selected model, `[r, g, b, amount]` in 0–1 (default yellow, 0.6). */
  readonly selectedHighlight?: readonly [number, number, number, number];
  /** The blend of a hovered model (default white, 0.25). */
  readonly hoverHighlight?: readonly [number, number, number, number];
}

interface Entry {
  readonly feature: ModelFeature;
  pose: ModelPose;
  /** The renderer's model id, once loaded. */
  model: number | undefined;
  state: Readonly<Record<string, unknown>>;
}

let nextLayer = 1;

/**
 * glTF models as layer features: picked, hovered, clicked, selected and dragged like the other primitives (F379–F382),
 * the selected and hovered ones blended toward a highlight color. Models load when the layer is added to a stack whose
 * target draws models (`LayerRenderTarget.models`); `ready` settles once all have loaded (a model that fails to load
 * emits `error` and is left out).
 */
export class ModelLayer extends LayerEmitter implements Layer {
  readonly id: string;
  readonly draggable: boolean;
  readonly #entries = new Map<FeatureId, Entry>();
  readonly #order: Entry[] = [];
  readonly #selected: readonly [number, number, number, number];
  readonly #hover: readonly [number, number, number, number];
  #context: LayerContext | undefined;
  #models: ModelRenderer | undefined;
  #slot = 0;
  #visible = true;
  #ready: Promise<void> = Promise.resolve();

  constructor(options: ModelLayerOptions) {
    super();
    this.id = options.id ?? `models-${String(nextLayer++)}`;
    this.draggable = options.draggable ?? false;
    this.#selected = options.selectedHighlight ?? [1, 1, 0, 0.6];
    this.#hover = options.hoverHighlight ?? [1, 1, 1, 0.25];
    for (const feature of options.models) {
      if (this.#entries.has(feature.id)) throw new RangeError(`Duplicate model id ${String(feature.id)}`);
      const entry: Entry = { feature, pose: poseOf(feature, feature.position), model: undefined, state: {} };
      this.#entries.set(feature.id, entry);
      this.#order.push(entry);
    }
  }

  /** Settles once every model has loaded or failed. */
  get ready(): Promise<void> {
    return this.#ready;
  }

  /** Loads the models into the target's model renderer. */
  attach(context: LayerContext): void {
    this.#context = context;
    this.#models = context.target.models;
    this.#slot = context.acquirePickSlot((index) => this.#picked(index));
    const models = this.#models;
    if (!models) {
      this.emit('error', { message: 'The render target draws no models' });
      return;
    }
    this.#ready = Promise.all(
      this.#order.map(async (entry, index) => {
        try {
          const id = await models.load(
            entry.feature.data ? { data: entry.feature.data } : { url: entry.feature.url ?? '' },
          );
          if (this.#context !== context) return models.remove(id);
          entry.model = id;
          models.setPose(id, entry.pose);
          models.setPickId?.(id, packPickId(this.#slot, index));
          models.setVisible?.(id, this.#visible);
          this.#applyState(entry);
          context.requestFrame();
        } catch (cause) {
          this.emit('error', { message: `Model ${String(entry.feature.id)} could not be loaded`, cause });
        }
      }),
    ).then(() => undefined);
  }

  /** Removes the models and frees the pick slot. */
  detach(): void {
    const context = this.#context;
    this.#context = undefined;
    for (const entry of this.#order) {
      if (entry.model !== undefined) this.#models?.remove(entry.model);
      entry.model = undefined;
    }
    if (context && this.#slot !== 0) context.releasePickSlot(this.#slot);
    this.#slot = 0;
  }

  /** Models are depth-tested volumes: they keep no draw order among the layers. */
  setOrder(): void {}

  /** Shows or hides every model of the layer. */
  setVisible(visible: boolean): void {
    this.#visible = visible;
    for (const entry of this.#order) if (entry.model !== undefined) this.#models?.setVisible?.(entry.model, visible);
    this.#context?.requestFrame();
  }

  /** Poses and highlights are written when they change, so a frame has nothing to do. */
  frame(): void {}

  /** A model's state, as `setFeatureState` set it. */
  getFeatureState(id: FeatureId): Readonly<Record<string, unknown>> | undefined {
    return this.#entries.get(id)?.state;
  }

  /** Merges state into a model's (`hover` and `selected` highlight it); `undefined` clears it. */
  setFeatureState(id: FeatureId, state: Readonly<Record<string, unknown>> | undefined): boolean {
    const entry = this.#entries.get(id);
    if (!entry) return false;
    entry.state = state === undefined ? {} : { ...entry.state, ...state };
    this.#applyState(entry);
    this.#context?.requestFrame();
    return true;
  }

  /** Moves a model (a drag, F382, or a live update). */
  setFeaturePosition(id: FeatureId, longitudeDeg: number, latitudeDeg: number, heightMeters = 0): boolean {
    const entry = this.#entries.get(id);
    if (!entry) return false;
    entry.pose = poseOf(entry.feature, { longitudeDeg, latitudeDeg, heightMeters });
    if (entry.model !== undefined) this.#models?.setPose(entry.model, entry.pose);
    this.#context?.requestFrame();
    return true;
  }

  #applyState(entry: Entry): void {
    if (entry.model === undefined) return;
    const highlight =
      entry.state['selected'] === true ? this.#selected : entry.state['hover'] === true ? this.#hover : undefined;
    this.#models?.setHighlight?.(entry.model, highlight);
  }

  #picked(index: number): PickedFeature | undefined {
    const entry = this.#order[index];
    return entry ? { layerId: this.id, id: entry.feature.id, properties: entry.feature.properties ?? {} } : undefined;
  }
}

function poseOf(feature: ModelFeature, position: GeoPosition): ModelPose {
  return {
    position,
    ...(feature.headingDeg === undefined ? {} : { headingDeg: feature.headingDeg }),
    ...(feature.pitchDeg === undefined ? {} : { pitchDeg: feature.pitchDeg }),
    ...(feature.rollDeg === undefined ? {} : { rollDeg: feature.rollDeg }),
    ...(feature.scale === undefined ? {} : { scale: feature.scale }),
  };
}
