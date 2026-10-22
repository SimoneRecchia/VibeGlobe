/**
 * Label placement and collision (F359, F360; docs/research/labels.md, ADR 0029). A placement pass runs at most every
 * `placementIntervalMs` (and at once when labels are added or removed): labels are tried in priority order (lower
 * `symbol-sort-key` first, then feature id, so the result never depends on input order), each kept only when its
 * screen box, padded, overlaps no box already kept; labels behind the globe or off screen are hidden. Between passes
 * the decisions stay, and each label's opacity moves toward its decision at a constant rate over `fadeDurationMs` on
 * the engine clock, so visibility changes are fades, never single-frame pops.
 */
import RBush from 'rbush';
import type { FeatureId } from './feature-store.js';
import type { ScreenProjector, TextMeasurer } from './render-target.js';

/** Placement settings. */
export interface PlacementOptions {
  /** Minimum time between placement passes (MapLibre uses 300 ms). */
  readonly placementIntervalMs?: number;
  /** Duration of a full fade in or out. */
  readonly fadeDurationMs?: number;
  /** Extra space kept free around each label, in CSS pixels. */
  readonly paddingPx?: number;
}

/** One label as placement sees it. */
export interface PlacementInput {
  readonly id: FeatureId;
  readonly longitudeDeg: number;
  readonly latitudeDeg: number;
  readonly heightMeters: number;
  readonly text: string;
  readonly sizePx: number;
  /** Anchor index (render-target.ts ANCHORS) and offset in ems, as MapLibre's `text-anchor` and `text-offset`. */
  readonly anchor: number;
  readonly offsetXEm: number;
  readonly offsetYEm: number;
  /** Lower places first (MapLibre `symbol-sort-key`). */
  readonly sortKey: number;
  /** False when the application hid the feature: it fades out and takes no space. */
  readonly enabled: boolean;
}

/** A screen box of a placed label, for the debug collision overlay. */
export interface CollisionBox {
  readonly id: FeatureId;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  /** Whether the pass kept the label. */
  readonly placed: boolean;
}

interface LabelState {
  opacity: number;
  target: number;
}

/** Fraction of the box width (x) and height (y) to shift for each anchor, so the anchor point lands on the position. */
const ANCHOR_SHIFT: readonly (readonly [number, number])[] = [
  [-0.5, -0.5],
  [0, -0.5],
  [-1, -0.5],
  [-0.5, 0],
  [-0.5, -1],
  [0, 0],
  [-1, 0],
  [0, -1],
  [-1, -1],
];

function compareInputs(a: PlacementInput, b: PlacementInput): number {
  if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
  const ka = String(a.id);
  const kb = String(b.id);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** Decides which labels show and fades them. */
export class LabelPlacer {
  readonly #intervalMs: number;
  readonly #fadeMs: number;
  readonly #paddingPx: number;
  readonly #measurer: TextMeasurer;
  readonly #states = new Map<FeatureId, LabelState>();
  readonly #tree = new RBush<CollisionBox>();
  #boxes: CollisionBox[] = [];
  #lastPlacementMs = -Infinity;
  #lastFrameMs: number | undefined;
  #forced = true;
  /** Placement passes run (instrumentation of collision cost, F359). */
  passes = 0;
  /** Duration of the last pass, in milliseconds of wall-clock time. */
  lastPassMs = 0;

  constructor(measurer: TextMeasurer, options: PlacementOptions = {}) {
    this.#measurer = measurer;
    this.#intervalMs = options.placementIntervalMs ?? 300;
    this.#fadeMs = options.fadeDurationMs ?? 300;
    this.#paddingPx = options.paddingPx ?? 2;
  }

  /** Requests a pass on the next update (labels were added, removed or changed). */
  invalidate(): void {
    this.#forced = true;
  }

  /** Boxes of the last pass. */
  get collisionBoxes(): readonly CollisionBox[] {
    return this.#boxes;
  }

  /**
   * Advances fades to `nowMs` and runs a placement pass when due.
   * @returns whether a pass ran.
   */
  update(nowMs: number, projector: ScreenProjector, labels: () => Iterable<PlacementInput>): boolean {
    const due = this.#forced || nowMs - this.#lastPlacementMs >= this.#intervalMs;
    if (due) {
      this.#place(labels(), projector);
      this.#lastPlacementMs = nowMs;
      this.#forced = false;
    }
    const elapsed = this.#lastFrameMs === undefined ? 0 : Math.max(0, nowMs - this.#lastFrameMs);
    this.#lastFrameMs = nowMs;
    const step = this.#fadeMs > 0 ? elapsed / this.#fadeMs : 1;
    for (const state of this.#states.values()) {
      if (state.opacity < state.target) state.opacity = Math.min(state.target, state.opacity + step);
      else if (state.opacity > state.target) state.opacity = Math.max(state.target, state.opacity - step);
    }
    return due;
  }

  /** Current opacity of a label (0 until it has been placed and faded in). */
  opacity(id: FeatureId): number {
    return this.#states.get(id)?.opacity ?? 0;
  }

  /** Whether the last pass kept a label. */
  isPlaced(id: FeatureId): boolean {
    return (this.#states.get(id)?.target ?? 0) === 1;
  }

  /** Forgets a removed label. */
  forget(id: FeatureId): void {
    this.#states.delete(id);
    this.#forced = true;
  }

  #place(labels: Iterable<PlacementInput>, projector: ScreenProjector): void {
    const started = performance.now();
    const sorted = [...labels].sort(compareInputs);
    this.#tree.clear();
    const boxes: CollisionBox[] = [];
    for (const label of sorted) {
      const box = label.enabled ? this.#box(label, projector) : undefined;
      const placed = box !== undefined && !this.#tree.collides(box);
      if (box !== undefined) {
        const recorded = { ...box, placed };
        boxes.push(recorded);
        if (placed) this.#tree.insert(recorded);
      }
      let state = this.#states.get(label.id);
      if (state === undefined) {
        state = { opacity: 0, target: 0 };
        this.#states.set(label.id, state);
      }
      state.target = placed ? 1 : 0;
    }
    this.#boxes = boxes;
    this.passes += 1;
    this.lastPassMs = performance.now() - started;
  }

  #box(label: PlacementInput, projector: ScreenProjector): CollisionBox | undefined {
    const point = projector.geoToScreen({
      longitudeDeg: label.longitudeDeg,
      latitudeDeg: label.latitudeDeg,
      heightMeters: label.heightMeters,
    });
    if (point === undefined || label.text.length === 0) return undefined;
    const { widthPx, heightPx } = this.#measurer.measure(label.text, label.sizePx);
    const [shiftX, shiftY] = ANCHOR_SHIFT[label.anchor] ?? [-0.5, -0.5];
    const minX = point.xPx + shiftX * widthPx + label.offsetXEm * label.sizePx - this.#paddingPx;
    const minY = point.yPx + shiftY * heightPx + label.offsetYEm * label.sizePx - this.#paddingPx;
    return {
      id: label.id,
      minX,
      minY,
      maxX: minX + widthPx + 2 * this.#paddingPx,
      maxY: minY + heightPx + 2 * this.#paddingPx,
      placed: false,
    };
  }
}
