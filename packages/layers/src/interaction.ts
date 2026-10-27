// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Feature interaction (F379–F382): hover enter and leave, click, selection and dragging, driven by pointer input and
 * the renderer's id buffer. Picks are asynchronous; a pick answered after a newer one was started is dropped, so
 * events always follow the latest pointer position and fire once each, in order. Hover and selection styles are
 * feature states (`['feature-state', 'hover']`, `['feature-state', 'selected']`).
 */
import type { GeoPosition, ScreenPoint } from '@vibeglobe/core';
import type { Project } from './anchors.js';
import type { FeatureId } from './feature-store.js';
import type { FeatureEvent, Layer, LayerEvents, PickedFeature } from './layer.js';
import type { LayerStack } from './layer-stack.js';

/** What the engine provides for interaction. */
export interface PickProvider {
  /** Reads the id buffer around a screen point (picking.ts `pickNearest`); 0 when nothing is there. */
  pick(point: ScreenPoint): Promise<number>;
  /** The geographic position under a screen point (terrain or ellipsoid), with its height when known. */
  screenToGeo(point: ScreenPoint): GeoPosition | undefined;
}

/** The parts of a layer interaction uses; {@link DataLayer} has them all. */
interface InteractiveLayer extends Layer {
  emit<K extends keyof LayerEvents>(type: K, payload: LayerEvents[K]): void;
  setFeatureState?(id: FeatureId, state: Readonly<Record<string, unknown>> | undefined): boolean;
  setFeaturePosition?(id: FeatureId, longitudeDeg: number, latitudeDeg: number, heightMeters?: number): boolean;
  readonly draggable?: boolean;
  /** How the layer places its features: on the ground (a height above the terrain) or at absolute altitudes. */
  readonly placement?: unknown;
  /** A feature's position, to keep its height above the ground while it is dragged (KB-129). */
  getPosition?(id: FeatureId): GeoPosition | undefined;
  /** Whether a feature anchor shows within `radiusPx` of `point`: the synchronous check before a drag (F382). */
  anchorNear?(point: ScreenPoint, radiusPx: number, project: Project): boolean;
}

interface Hit {
  readonly layer: InteractiveLayer;
  readonly feature: PickedFeature;
}

const isInteractive = (layer: Layer): layer is InteractiveLayer =>
  typeof (layer as Partial<InteractiveLayer>).emit === 'function';

/** Turns pointer input into feature events. */
export class InteractionController {
  readonly #stack: LayerStack;
  readonly #provider: PickProvider;
  #sequence = 0;
  #hover: Hit | undefined;
  #pressed: Hit | undefined;
  /** The pick of the latest press, which a release waits for (KB-111). */
  #pressing: Promise<Hit | undefined> | undefined;
  #dragging = false;
  readonly #selected = new Map<string, Hit>();

  constructor(stack: LayerStack, provider: PickProvider) {
    this.#stack = stack;
    this.#provider = provider;
  }

  /** The hovered feature. */
  get hovered(): PickedFeature | undefined {
    return this.#hover?.feature;
  }

  /** Whether a feature drag is running (the map must not pan meanwhile). */
  get dragging(): boolean {
    return this.#dragging;
  }

  /** Selected features. */
  get selection(): readonly PickedFeature[] {
    return [...this.#selected.values()].map((hit) => hit.feature);
  }

  /**
   * True when a press at `point` lands near the anchor of a feature in a draggable layer (within `radiusPx`): the map's
   * own gestures must not start, since the asynchronous pick confirms the feature only frames later (F382).
   */
  pressesDraggable(point: ScreenPoint, radiusPx: number, project: Project): boolean {
    for (const id of this.#stack.order) {
      const layer = this.#stack.get(id);
      if (layer === undefined || !isInteractive(layer) || layer.draggable !== true) continue;
      if (this.#stack.isVisible(id) && layer.anchorNear?.(point, radiusPx, project) === true) return true;
    }
    return false;
  }

  /** Handles a pointer move: drags the pressed feature, or updates the hover. */
  async pointerMove(point: ScreenPoint): Promise<void> {
    if (this.#pressed !== undefined && this.#pressed.layer.draggable === true) {
      this.#drag(point);
      return;
    }
    const hit = await this.#pick(point);
    if (hit === null) return;
    this.#setHover(hit, point);
  }

  /**
   * Handles a pointer press.
   * @returns true when the press landed on a draggable feature, so the map's own gestures must ignore it.
   */
  async pointerDown(point: ScreenPoint): Promise<boolean> {
    // A press supersedes pending hover picks but is never superseded itself: its release waits for it (KB-111).
    this.#sequence++;
    const pending = this.#resolve(point);
    this.#pressing = pending;
    const hit = await pending;
    if (this.#pressing !== pending) return false;
    this.#pressing = undefined;
    this.#pressed = hit;
    this.#dragging = false;
    return hit?.layer.draggable === true;
  }

  /** Handles a pointer release: ends a drag, or clicks the feature pressed and released on. */
  async pointerUp(point: ScreenPoint): Promise<void> {
    if (this.#pressing !== undefined) await this.#pressing;
    const pressed = this.#pressed;
    this.#pressed = undefined;
    if (pressed === undefined) return;
    if (this.#dragging) {
      this.#dragging = false;
      pressed.layer.emit('drag-end', this.#event(pressed, point));
      return;
    }
    this.#sequence++;
    const hit = await this.#resolve(point);
    if (hit === undefined) return;
    if (hit.layer === pressed.layer && hit.feature.id === pressed.feature.id)
      hit.layer.emit('click', this.#event(hit, point));
  }

  /** The pointer left the canvas. */
  pointerLeave(point: ScreenPoint): void {
    this.#sequence++;
    this.#setHover(undefined, point);
  }

  /** Selects a feature (through a click handler or the API); its `selected` feature state is set. */
  select(layerId: string, id: FeatureId): boolean {
    const layer = this.#stack.get(layerId);
    if (layer === undefined || !isInteractive(layer)) return false;
    const changed = layer.setFeatureState?.(id, { selected: true }) ?? false;
    if (changed)
      this.#selected.set(`${layerId}\u0000${String(id)}`, { layer, feature: { layerId, id, properties: {} } });
    return changed;
  }

  /** Removes a feature from the selection. */
  deselect(layerId: string, id: FeatureId): boolean {
    const key = `${layerId}\u0000${String(id)}`;
    const hit = this.#selected.get(key);
    if (hit === undefined) return false;
    this.#selected.delete(key);
    hit.layer.setFeatureState?.(id, { selected: false });
    return true;
  }

  /** Clears the selection. */
  clearSelection(): void {
    for (const hit of [...this.#selected.values()]) this.deselect(hit.feature.layerId, hit.feature.id);
  }

  /** Resolves a pick; `null` when a newer pick superseded it. */
  async #pick(point: ScreenPoint): Promise<Hit | undefined | null> {
    const sequence = ++this.#sequence;
    const hit = await this.#resolve(point);
    return sequence === this.#sequence ? hit : null;
  }

  /** The interactive feature at a screen point. */
  async #resolve(point: ScreenPoint): Promise<Hit | undefined> {
    const id = await this.#provider.pick(point);
    const resolved = this.#stack.resolvePick(id);
    if (resolved === undefined || !isInteractive(resolved.layer)) return undefined;
    return { layer: resolved.layer, feature: resolved.feature };
  }

  #setHover(hit: Hit | undefined, point: ScreenPoint): void {
    const previous = this.#hover;
    if (previous?.layer === hit?.layer && previous?.feature.id === hit?.feature.id) return;
    this.#hover = hit;
    if (previous !== undefined) {
      previous.layer.setFeatureState?.(previous.feature.id, { hover: false });
      previous.layer.emit('hover-leave', this.#event(previous, point));
    }
    if (hit !== undefined) {
      hit.layer.setFeatureState?.(hit.feature.id, { hover: true });
      hit.layer.emit('hover-enter', this.#event(hit, point));
    }
  }

  #drag(point: ScreenPoint): void {
    const pressed = this.#pressed as Hit;
    const position = this.#provider.screenToGeo(point);
    if (!this.#dragging) {
      this.#dragging = true;
      pressed.layer.emit('drag-start', this.#event(pressed, point));
    }
    if (position === undefined) return;
    // On the ground a feature keeps its height above the terrain; at absolute altitudes it takes the picked one.
    const onGround = typeof pressed.layer.placement === 'string';
    const height = onGround
      ? (pressed.layer.getPosition?.(pressed.feature.id)?.heightMeters ?? 0)
      : (position.heightMeters ?? 0);
    pressed.layer.setFeaturePosition?.(pressed.feature.id, position.longitudeDeg, position.latitudeDeg, height);
    pressed.layer.emit('drag', { feature: pressed.feature, position, screenPoint: point });
  }

  #event(hit: Hit, point: ScreenPoint): FeatureEvent {
    return { feature: hit.feature, position: this.#provider.screenToGeo(point), screenPoint: point };
  }
}
