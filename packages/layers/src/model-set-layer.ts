// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { GeoPosition, ModelPose, ModelRenderer, ModelSetJoint } from '@vibeglobe/core';
import type { FeatureId } from './feature-store.js';
import { LayerEmitter, type FrameContext, type Layer, type LayerContext, type PickedFeature } from './layer.js';
import { finite, SpinMotion, YawMotion } from './model-set-motion.js';
import { packPickId } from './picking.js';

/** One copy of a {@link ModelSetLayer}'s model: where it stands and its properties. */
export interface ModelSetItem {
  readonly id: FeatureId;
  readonly position: GeoPosition;
  readonly headingDeg?: number;
  readonly pitchDeg?: number;
  readonly rollDeg?: number;
  readonly scale?: number;
  /** This copy's turns per minute (F648), instead of `spin.rpm`. */
  readonly spinRpm?: number;
  /** The direction this copy's yawing part faces at start, degrees clockwise from north (default: its heading). */
  readonly yawDeg?: number;
  readonly properties?: Readonly<Record<string, unknown>>;
}

/** A part of the model that turns, such as a wind turbine's rotor (F648). */
export interface ModelSetSpin {
  /** The glTF node that turns, with its children, about its own Z axis (the playground's turbine: `'rotor'`). */
  readonly node: string;
  /** Turns per minute of every copy (default 0); positive turns clockwise seen from the node's −Z (a rotor's front). */
  readonly rpm?: number;
  /** Seconds a change of speed takes to settle, as a rotor speeds up and slows down (default 4; 0: at once). */
  readonly rampSeconds?: number;
}

/** A part of the model that turns about the vertical, such as a wind turbine's nacelle on its tower (F648). */
export interface ModelSetYaw {
  /** The glTF node that turns, with its children, about its own Y axis (the playground's turbine: `'nacelle'`). */
  readonly node: string;
  /** How fast it turns to a new direction, degrees per second (default 6). */
  readonly degPerSecond?: number;
}

/** Options of {@link ModelSetLayer}. */
export interface ModelSetLayerOptions {
  readonly id?: string;
  /** The glTF file every copy shows: its URL, or its bytes. */
  readonly url?: string;
  readonly data?: ArrayBuffer;
  readonly models: readonly ModelSetItem[];
  /** Copies nearer the eye than this show the model, farther ones the placeholder, meters (default 3,000). */
  readonly visibleBelowMeters?: number;
  /** The placeholder of a far copy: its color `[r, g, b]` from 0 to 1 and its size on screen (default 10 px; 0: none). */
  readonly placeholder?: { readonly color?: readonly [number, number, number]; readonly sizePx?: number };
  /** The blend toward a color of a selected copy, `[r, g, b, amount]` in 0–1 (default yellow, 0.6). */
  readonly selectedHighlight?: readonly [number, number, number, number];
  /** The blend of a hovered copy (default white, 0.25). */
  readonly hoverHighlight?: readonly [number, number, number, number];
  /** A part that spins (F648): set speeds at runtime with {@link ModelSetLayer.setSpinRpm}. */
  readonly spin?: ModelSetSpin;
  /** A part that turns to face a direction (F648), with {@link ModelSetLayer.setYawDeg}; it holds the spinning part. */
  readonly yaw?: ModelSetYaw;
}

let nextLayer = 1;

/**
 * Many copies of one glTF model (F627), such as the turbines of a wind farm: the file loads once and each of its meshes
 * is one instanced draw for every copy in view within `visibleBelowMeters`; farther copies are one instanced draw of a
 * small placeholder, and copies outside the view cost no drawing. Copies are picked, hovered, clicked and selected like
 * the other features (F379–F381). The target must draw model sets (`ModelRenderer.loadSet`, `@vibeglobe/renderer`).
 */
export class ModelSetLayer extends LayerEmitter implements Layer {
  readonly id: string;
  /** Copies cannot be dragged: move them with {@link ModelSetLayer.setFeaturePosition}. */
  readonly draggable = false;
  readonly #items: ModelSetItem[];
  readonly #index = new Map<FeatureId, number>();
  readonly #poses: ModelPose[];
  readonly #states: Readonly<Record<string, unknown>>[];
  readonly #options: ModelSetLayerOptions;
  #context: LayerContext | undefined;
  #models: ModelRenderer | undefined;
  #set: number | undefined;
  #slot = 0;
  #visible = true;
  #ready: Promise<void> = Promise.resolve();
  readonly #spin: SpinMotion | undefined;
  readonly #yaw: YawMotion | undefined;
  #lastMs: number | undefined;
  /** Frames still to draw whatever the renderer drew last: after loading, a change of motion or showing the layer. */
  #kick = 0;

  constructor(options: ModelSetLayerOptions) {
    super();
    if ((options.url === undefined) === (options.data === undefined))
      throw new RangeError('A model set needs either a url or data');
    const below = options.visibleBelowMeters ?? 3000;
    if (!(below >= 0 && Number.isFinite(below))) throw new RangeError('visibleBelowMeters must be a number ≥ 0');
    this.id = options.id ?? `model-set-${String(nextLayer++)}`;
    this.#options = options;
    this.#items = [...options.models];
    this.#items.forEach((item, index) => {
      if (this.#index.has(item.id)) throw new RangeError(`Duplicate model id ${String(item.id)}`);
      this.#index.set(item.id, index);
    });
    this.#poses = this.#items.map((item) => poseOf(item, item.position));
    this.#states = this.#items.map(() => ({}));
    const { spin, yaw } = options;
    this.#spin = spin
      ? new SpinMotion(
          this.#items.map((item) => item.spinRpm ?? finite(spin.rpm ?? 0, 'spin.rpm')),
          spin.rampSeconds ?? 4,
        )
      : undefined;
    this.#yaw = yaw
      ? new YawMotion(
          this.#items.map((item) => item.headingDeg ?? 0),
          this.#items.map((item) => item.yawDeg ?? item.headingDeg ?? 0),
          yaw.degPerSecond ?? 6,
        )
      : undefined;
  }

  /** Settles once the model has loaded or failed. */
  get ready(): Promise<void> {
    return this.#ready;
  }

  /** Loads the model once into the target's model renderer and hands it every copy. */
  attach(context: LayerContext): void {
    this.#context = context;
    this.#models = context.target.models;
    this.#slot = context.acquirePickSlot((index) => this.#picked(index));
    const models = this.#models;
    if (!models?.loadSet) {
      this.emit('error', { message: 'The render target draws no model sets' });
      return;
    }
    const options = this.#options;
    this.#ready = models
      .loadSet(options.data ? { data: options.data } : { url: options.url ?? '' }, {
        visibleBelowMeters: options.visibleBelowMeters ?? 3000,
        placeholderColor: options.placeholder?.color ?? [0.95, 0.95, 0.97],
        placeholderSizePx: options.placeholder?.sizePx ?? 10,
        ...(options.spin || options.yaw ? { joints: this.#joints().map(([joint]) => joint) } : {}),
      })
      .then(
        (id) => {
          if (this.#context !== context) return models.remove(id);
          this.#set = id;
          models.setInstances?.(
            id,
            this.#poses,
            this.#items.map((_, index) => packPickId(this.#slot, index)),
          );
          models.setVisible?.(id, this.#visible);
          this.#joints().forEach(([, angles], joint) => models.setInstanceAngles?.(id, joint, angles));
          this.#kick = 2;
          this.#items.forEach((_, index) => this.#applyState(index));
          context.requestFrame();
        },
        (cause: unknown) => this.emit('error', { message: 'The model set could not be loaded', cause }),
      );
  }

  /** Removes the set, frees the pick slot and drops the event handlers. */
  detach(): void {
    const context = this.#context;
    this.#context = undefined;
    if (this.#set !== undefined) this.#models?.remove(this.#set);
    this.#set = undefined;
    if (context && this.#slot !== 0) context.releasePickSlot(this.#slot);
    this.#slot = 0;
    this.clear();
  }

  /** Models are depth-tested volumes: they keep no draw order among the layers. */
  setOrder(): void {}

  /** Shows or hides every copy. */
  setVisible(visible: boolean): void {
    this.#visible = visible;
    this.#kick = 2;
    if (this.#set !== undefined) this.#models?.setVisible?.(this.#set, visible);
    this.#context?.requestFrame();
  }

  /**
   * Moves the turning parts (F648): spinning parts ease toward their speed, yawing parts turn toward their direction,
   * and frames are asked for while a part moves where the renderer draws the model; the renderer places the copies.
   */
  frame(frame: FrameContext): void {
    const dt = Math.min(Math.max(frame.nowMs - (this.#lastMs ?? frame.nowMs), 0), 250);
    this.#lastMs = frame.nowMs;
    if (this.#set === undefined) return;
    // Both step every frame.
    const spinning = this.#spin?.step(dt) ?? false;
    const yawing = this.#yaw?.step(dt) ?? false;
    const drawn = this.#models?.drawnInstances?.(this.#set) ?? 1;
    if (this.#kick > 0) this.#kick--;
    if ((spinning || yawing) && this.#visible && (drawn > 0 || this.#kick > 0)) this.#context?.requestFrame();
  }

  /**
   * Sets the turns per minute of the spinning part of every copy, or of one (F648); the speed eases to it over
   * `spin.rampSeconds`. False for an unknown id or a layer without `spin`.
   */
  setSpinRpm(rpm: number, id?: FeatureId): boolean {
    return this.#move(this.#spin, rpm, id);
  }

  /** The turns per minute a copy's spinning part is heading for, or undefined. */
  getSpinRpm(id: FeatureId): number | undefined {
    const index = this.#index.get(id);
    return index === undefined ? undefined : this.#spin?.target(index);
  }

  /**
   * Turns the yawing part of every copy, or of one, to face a direction, degrees clockwise from north (F648): a wind
   * turbine's rotor into the wind. It turns at `yaw.degPerSecond`, the shorter way round. False for an unknown id or a
   * layer without `yaw`.
   */
  setYawDeg(facingDeg: number, id?: FeatureId): boolean {
    return this.#move(this.#yaw, facingDeg, id);
  }

  /** The direction a copy's yawing part is turning to face, degrees clockwise from north, or undefined. */
  getYawDeg(id: FeatureId): number | undefined {
    const index = this.#index.get(id);
    return index === undefined ? undefined : this.#yaw?.target(index);
  }

  /** The renderer's joints, outermost first, with their angles. */
  #joints(): [ModelSetJoint, Float32Array][] {
    const { spin, yaw } = this.#options;
    return [
      ...(yaw && this.#yaw ? [[{ node: yaw.node, axis: 'y' }, this.#yaw.angles] as [ModelSetJoint, Float32Array]] : []),
      ...(spin && this.#spin
        ? [[{ node: spin.node, axis: 'z' }, this.#spin.angles] as [ModelSetJoint, Float32Array]]
        : []),
    ];
  }

  #move(motion: SpinMotion | YawMotion | undefined, value: number, id: FeatureId | undefined): boolean {
    const index = id === undefined ? undefined : this.#index.get(id);
    if (!motion || (id !== undefined && index === undefined)) return false;
    motion.set(value, index);
    this.#kick = 2;
    this.#context?.requestFrame();
    return true;
  }

  /** A copy's state, as `setFeatureState` set it. */
  getFeatureState(id: FeatureId): Readonly<Record<string, unknown>> | undefined {
    const index = this.#index.get(id);
    return index === undefined ? undefined : this.#states[index];
  }

  /** Merges state into a copy's (`hover` and `selected` highlight it); `undefined` clears it. */
  setFeatureState(id: FeatureId, state: Readonly<Record<string, unknown>> | undefined): boolean {
    const index = this.#index.get(id);
    if (index === undefined) return false;
    this.#states[index] = state === undefined ? {} : { ...this.#states[index], ...state };
    this.#applyState(index);
    this.#context?.requestFrame();
    return true;
  }

  /** A copy's position. */
  getPosition(id: FeatureId): GeoPosition | undefined {
    const index = this.#index.get(id);
    return index === undefined ? undefined : this.#poses[index]?.position;
  }

  /** Moves a copy (a live update). */
  setFeaturePosition(id: FeatureId, longitudeDeg: number, latitudeDeg: number, heightMeters = 0): boolean {
    const index = this.#index.get(id);
    const item = index === undefined ? undefined : this.#items[index];
    if (index === undefined || !item) return false;
    this.#poses[index] = poseOf(item, { longitudeDeg, latitudeDeg, heightMeters });
    if (this.#set !== undefined)
      this.#models?.setInstances?.(
        this.#set,
        this.#poses,
        this.#items.map((_, i) => packPickId(this.#slot, i)),
      );
    this.#context?.requestFrame();
    return true;
  }

  #applyState(index: number): void {
    if (this.#set === undefined) return;
    const state = this.#states[index] ?? {};
    const highlight =
      state['selected'] === true
        ? (this.#options.selectedHighlight ?? [1, 1, 0, 0.6])
        : state['hover'] === true
          ? (this.#options.hoverHighlight ?? [1, 1, 1, 0.25])
          : undefined;
    this.#models?.setInstanceHighlight?.(this.#set, index, highlight);
  }

  #picked(index: number): PickedFeature | undefined {
    const item = this.#items[index];
    return item ? { layerId: this.id, id: item.id, properties: item.properties ?? {} } : undefined;
  }
}

function poseOf(item: ModelSetItem, position: GeoPosition): ModelPose {
  return {
    position,
    ...(item.headingDeg === undefined ? {} : { headingDeg: item.headingDeg }),
    ...(item.pitchDeg === undefined ? {} : { pitchDeg: item.pitchDeg }),
    ...(item.rollDeg === undefined ? {} : { rollDeg: item.rollDeg }),
    ...(item.scale === undefined ? {} : { scale: item.scale }),
  };
}
