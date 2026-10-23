/**
 * Label placement and collision (F359, F360; docs/research/labels.md, ADR 0029). A placement pass runs at most every
 * `placementIntervalMs` (and at once when labels are added or removed): labels are tried in priority order (lower
 * `symbol-sort-key` first, then feature id, so the result never depends on input order), each kept only when its
 * screen box, padded, overlaps no box already kept; labels behind the globe or off screen are hidden. Between passes
 * the decisions stay, and each label's opacity moves toward its decision at a constant rate over `fadeDurationMs` on
 * the engine clock, so visibility changes are fades, never single-frame pops. A pass over many labels is sliced across
 * frames, at most `budgetMs` of work per frame; its decisions apply together when it ends.
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
  /** Placement work allowed per frame, in milliseconds; a longer pass continues on the next frames. */
  readonly budgetMs?: number;
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

interface Keyed {
  readonly input: PlacementInput;
  readonly key: string;
}

function compareInputs(a: Keyed, b: Keyed): number {
  if (a.input.sortKey !== b.input.sortKey) return a.input.sortKey - b.input.sortKey;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** A pass in progress: the labels read so far, then in priority order, how far it got, and what it kept so far. */
interface Pass {
  readonly source: Iterator<PlacementInput>;
  readonly read: PlacementInput[];
  readAll: boolean;
  sorted: readonly PlacementInput[] | undefined;
  next: number;
  readonly tree: RBush<CollisionBox>;
  readonly boxes: CollisionBox[];
  readonly placed: Set<FeatureId>;
  workMs: number;
}

/** A label's measured text. */
interface Measured {
  readonly text: string;
  readonly sizePx: number;
  readonly widthPx: number;
  readonly heightPx: number;
}

/** Labels tried between two clock reads. */
const CHECK_EVERY = 64;
/** Measurements kept before the cache starts over. */
const MEASURE_CACHE = 50_000;

/** Decides which labels show and fades them. */
export class LabelPlacer {
  readonly #intervalMs: number;
  readonly #fadeMs: number;
  readonly #paddingPx: number;
  readonly #budgetMs: number;
  #measurer: TextMeasurer;
  readonly #sizes = new Map<FeatureId, Measured>();
  readonly #states = new Map<FeatureId, LabelState>();
  #boxes: CollisionBox[] = [];
  #pass: Pass | undefined;
  /** Frames drawn since the last pass ended: the view may have changed since its decisions. */
  #stale = false;
  #lastPlacementMs = -Infinity;
  #lastFrameMs: number | undefined;
  #forced = true;
  /** Placement passes run (instrumentation of collision cost, F359). */
  passes = 0;
  /** Work of the last pass, in milliseconds of wall-clock time, over all its frames. */
  lastPassMs = 0;
  /** The longest placement work done in one frame (the per-frame collision cost, F359). */
  maxFrameMs = 0;
  /** The placement work of the last frames that did any, in milliseconds, oldest first (at most 256). */
  readonly frameMs: number[] = [];

  constructor(measurer: TextMeasurer, options: PlacementOptions = {}) {
    this.#measurer = measurer;
    this.#intervalMs = options.placementIntervalMs ?? 300;
    this.#fadeMs = options.fadeDurationMs ?? 300;
    this.#paddingPx = options.paddingPx ?? 2;
    this.#budgetMs = options.budgetMs ?? 4;
  }

  /** Whether placement is unfinished: a pass in progress, or frames drawn since the last one (ask for a frame). */
  get pending(): boolean {
    return this.#pass !== undefined || this.#stale || this.#forced;
  }

  /** Requests a pass on the next update (labels were added, removed or changed). */
  invalidate(): void {
    this.#pass = undefined;
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
    let ended = false;
    if (this.#pass === undefined) {
      const due = this.#forced || (this.#stale && nowMs - this.#lastPlacementMs >= this.#intervalMs);
      if (due) {
        this.#pass = this.#start(labels());
        this.#forced = false;
        this.#stale = false;
      } else if (this.#lastFrameMs !== undefined) this.#stale = true;
    }
    if (this.#pass !== undefined) ended = this.#continue(this.#pass, projector);
    // Passes end at least the interval apart, so a label's decision never reverses within a fade (F360).
    if (ended) this.#lastPlacementMs = nowMs;
    const elapsed = this.#lastFrameMs === undefined ? 0 : Math.max(0, nowMs - this.#lastFrameMs);
    this.#lastFrameMs = nowMs;
    const step = this.#fadeMs > 0 ? elapsed / this.#fadeMs : 1;
    for (const state of this.#states.values()) {
      if (state.opacity < state.target) state.opacity = Math.min(state.target, state.opacity + step);
      else if (state.opacity > state.target) state.opacity = Math.max(state.target, state.opacity - step);
    }
    return ended;
  }

  /** Current opacity of a label (0 until it has been placed and faded in). */
  opacity(id: FeatureId): number {
    return this.#states.get(id)?.opacity ?? 0;
  }

  /** Whether the last pass kept a label. */
  isPlaced(id: FeatureId): boolean {
    return (this.#states.get(id)?.target ?? 0) === 1;
  }

  /** Measures with other glyph metrics (the renderer's, once attached) from the next pass on. */
  setMeasurer(measurer: TextMeasurer): void {
    this.#measurer = measurer;
    this.#sizes.clear();
    this.#forced = true;
  }

  /** Forgets a removed label. */
  forget(id: FeatureId): void {
    this.#states.delete(id);
    this.#sizes.delete(id);
    this.#pass = undefined;
    this.#forced = true;
  }

  #start(labels: Iterable<PlacementInput>): Pass {
    const source = labels[Symbol.iterator]();
    return {
      source,
      read: [],
      readAll: false,
      sorted: undefined,
      next: 0,
      tree: new RBush(),
      boxes: [],
      placed: new Set(),
      workMs: 0,
    };
  }

  /**
   * Reads the labels until they are all read or the deadline passes, and sorts them on the next frame (so the sort
   * starts a frame's budget instead of overrunning it); whether they are sorted.
   */
  #read(pass: Pass, deadline: number): boolean {
    if (!pass.readAll)
      for (let n = 1; ; n++) {
        const next = pass.source.next();
        if (next.done === true) {
          pass.readAll = true;
          return false;
        }
        pass.read.push(next.value);
        if (n % CHECK_EVERY === 0 && performance.now() >= deadline) return false;
      }
    pass.sorted = pass.read
      .map((input) => ({ input, key: String(input.id) }))
      .sort(compareInputs)
      .map((keyed) => keyed.input);
    return true;
  }

  /** Places labels until the pass ends or this frame's budget is spent; at the end, applies its decisions. */
  #continue(pass: Pass, projector: ScreenProjector): boolean {
    const started = performance.now();
    const deadline = started + this.#budgetMs;
    const sorted = pass.sorted ?? (this.#read(pass, deadline) ? pass.sorted : undefined);
    const { tree, boxes } = pass;
    while (sorted && pass.next < sorted.length && performance.now() < deadline) {
      const label = sorted[pass.next++];
      if (!label) continue;
      const box = label.enabled ? this.#box(label, projector) : undefined;
      const placed = box !== undefined && !tree.collides(box);
      if (box !== undefined) {
        box.placed = placed;
        boxes.push(box);
        if (placed) {
          tree.insert(box);
          pass.placed.add(label.id);
        }
      }
    }
    const frameMs = performance.now() - started;
    this.maxFrameMs = Math.max(this.maxFrameMs, frameMs);
    if (this.frameMs.push(frameMs) > 256) this.frameMs.shift();
    pass.workMs += frameMs;
    if (!sorted || pass.next < sorted.length) return false;
    for (const input of sorted) {
      let state = this.#states.get(input.id);
      if (state === undefined) {
        state = { opacity: 0, target: 0 };
        this.#states.set(input.id, state);
      }
      state.target = pass.placed.has(input.id) ? 1 : 0;
    }
    this.#boxes = boxes;
    this.#pass = undefined;
    this.passes += 1;
    this.lastPassMs = pass.workMs;
    return true;
  }

  /** A label's text size, measured again only when its text or size changes. */
  #measure(id: FeatureId, text: string, sizePx: number): { readonly widthPx: number; readonly heightPx: number } {
    let size = this.#sizes.get(id);
    if (size === undefined || size.text !== text || size.sizePx !== sizePx) {
      if (this.#sizes.size >= MEASURE_CACHE) this.#sizes.clear();
      const { widthPx, heightPx } = this.#measurer.measure(text, sizePx);
      size = { text, sizePx, widthPx, heightPx };
      this.#sizes.set(id, size);
    }
    return size;
  }

  #box(
    label: PlacementInput,
    projector: ScreenProjector,
  ): { -readonly [K in keyof CollisionBox]: CollisionBox[K] } | undefined {
    const point = projector.geoToScreen({
      longitudeDeg: label.longitudeDeg,
      latitudeDeg: label.latitudeDeg,
      heightMeters: label.heightMeters,
    });
    if (point === undefined || label.text.length === 0) return undefined;
    const { widthPx, heightPx } = this.#measure(label.id, label.text, label.sizePx);
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
