/**
 * The public layer plug-in interface (F388): built-in layers and application layers implement {@link Layer}, and the
 * {@link LayerStack} drives them: attach when added, one `frame` per drawn frame, order and visibility changes, detach
 * when removed.
 */
import type { GeoPosition, ScreenPoint } from '@vibeglobe/core';
import type { FeatureId } from './feature-store.js';
import type { LayerRenderTarget, ScreenProjector } from './render-target.js';

/** A feature returned by picking and carried by events. */
export interface PickedFeature {
  readonly layerId: string;
  readonly id: FeatureId;
  readonly properties: Readonly<Record<string, unknown>>;
}

/** What the stack gives a layer when it is added. */
export interface LayerContext {
  readonly target: LayerRenderTarget;
  /**
   * Reserves a pick slot (picking.ts) whose ids the layer writes into its batches' `pickId` attribute; `resolve` maps
   * a feature index of that slot back to the feature.
   */
  acquirePickSlot(resolve: (featureIndex: number) => PickedFeature | undefined): number;
  /** Frees a slot acquired by this layer. */
  releasePickSlot(slot: number): void;
  /** Asks the host for a frame, in which the layer writes its changes (a globe draws only when asked). */
  requestFrame(): void;
}

/** Per-frame input of a layer. */
export interface FrameContext {
  /** Engine clock time (`Globe.timeMs`). */
  readonly nowMs: number;
  /** Web Mercator zoom, continuous. */
  readonly zoom: number;
  readonly projector: ScreenProjector;
}

/** Batches of one layer may use draw orders `order × ORDER_STRIDE` to `order × ORDER_STRIDE + ORDER_STRIDE − 1`. */
export const ORDER_STRIDE = 16;

/** A layer the stack can hold. */
export interface Layer {
  /** Unique within a stack. */
  readonly id: string;
  /** Creates renderer resources; called once when added to a stack. */
  attach(context: LayerContext): void;
  /** Frees every renderer resource, pick slot, timer and pending work; called when removed. */
  detach(): void;
  /** Sets the layer's position in the stack (0 = bottom); batches draw at `order × ORDER_STRIDE + k`. */
  setOrder(order: number): void;
  /** Shows or hides the whole layer. */
  setVisible(visible: boolean): void;
  /** Called once per frame before drawing, to flush changes and advance animations. */
  frame(frame: FrameContext): void;
}

/** Events of feature interaction (F379–F382). */
export interface FeatureEvent {
  readonly feature: PickedFeature;
  /** Geographic position under the pointer, height included when known (terrain or the feature). */
  readonly position: GeoPosition | undefined;
  readonly screenPoint: ScreenPoint;
}

/** Event names and payloads of layers. */
export interface LayerEvents {
  'hover-enter': FeatureEvent;
  'hover-leave': FeatureEvent;
  click: FeatureEvent;
  'drag-start': FeatureEvent;
  drag: FeatureEvent;
  'drag-end': FeatureEvent;
  /** Data could not be loaded or parsed; the layer keeps its previous features. */
  error: { readonly message: string; readonly cause?: unknown };
  /** A streamed or loaded batch of features was added. */
  data: { readonly added: number; readonly total: number };
}

/** A small typed event emitter shared by the layers. */
export class LayerEmitter {
  readonly #handlers = new Map<keyof LayerEvents, Set<(payload: never) => void>>();

  /**
   * Adds a handler.
   * @returns a function that removes it.
   */
  on<K extends keyof LayerEvents>(type: K, handler: (payload: LayerEvents[K]) => void): () => void {
    let set = this.#handlers.get(type);
    if (set === undefined) {
      set = new Set();
      this.#handlers.set(type, set);
    }
    set.add(handler as (payload: never) => void);
    return () => set.delete(handler as (payload: never) => void);
  }

  /** Calls every handler of an event. */
  emit<K extends keyof LayerEvents>(type: K, payload: LayerEvents[K]): void {
    const set = this.#handlers.get(type);
    if (set === undefined) return;
    for (const handler of [...set]) (handler as (p: LayerEvents[K]) => void)(payload);
  }

  /** Number of handlers, for leak checks. */
  get listenerCount(): number {
    let count = 0;
    for (const set of this.#handlers.values()) count += set.size;
    return count;
  }

  /** Removes every handler. */
  clear(): void {
    this.#handlers.clear();
  }
}
