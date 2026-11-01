// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Label placement and collision (F359, F360; docs/internal/research/labels.md, ADR 0029). A placement pass runs at most every
 * `placementIntervalMs` (and at once when labels are added or removed): labels are tried in priority order (lower
 * `symbol-sort-key` first, then feature id, so the result never depends on input order), each kept only when its
 * screen box, padded, overlaps no box already kept; labels behind the globe or off screen are hidden. Between passes
 * the decisions stay, and each label's opacity moves toward its decision at a constant rate over `fadeDurationMs` on
 * the engine clock, so visibility changes are fades, never single-frame pops. A pass over many labels is sliced across
 * frames, at most `budgetMs` of work per frame; its decisions apply together when it ends. A pass keeps what it reads and
 * the boxes it builds in storage reused from pass to pass (KB-171): objects it allocated and kept across its frames were
 * copied by every young-generation collection, which then ran inside its slices, several milliseconds over the budget.
 */
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

type MutableBox = { -readonly [K in keyof CollisionBox]: CollisionBox[K] };

/**
 * A pass in progress: how many labels it read (into the placer's reused arrays), whether they are sorted (the placer's
 * `order`), how far it got, and how many boxes it built.
 */
interface Pass {
  readonly source: Iterator<PlacementInput>;
  count: number;
  readAll: boolean;
  sorted: boolean;
  next: number;
  boxCount: number;
  workMs: number;
}

/** Grid cell size of the collision index, in CSS pixels. */
const CELL_PX = 32;
/** Buckets of the collision index (a power of two). */
const BUCKETS = 4096;

/**
 * The kept boxes of a pass, by grid cell, in typed arrays reused from pass to pass: an rbush allocated on every query
 * and insert (KB-171). Cells hash into buckets; a box is tested against every box of the buckets its cells fall in.
 */
class BoxGrid {
  readonly #heads = new Int32Array(BUCKETS).fill(-1);
  #next = new Int32Array(4096);
  #box = new Int32Array(4096);
  #entries = 0;
  readonly #boxes: MutableBox[] = [];

  clear(): void {
    this.#heads.fill(-1);
    this.#entries = 0;
    this.#boxes.length = 0;
  }

  /** Whether `box` overlaps a kept box; boxes with coordinates that are not finite always do (never shown). */
  collides(box: CollisionBox): boolean {
    const x0 = Math.floor(box.minX / CELL_PX);
    const x1 = Math.floor(box.maxX / CELL_PX);
    const y0 = Math.floor(box.minY / CELL_PX);
    const y1 = Math.floor(box.maxY / CELL_PX);
    if (!Number.isFinite(x0 + x1 + y0 + y1)) return true;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++)
        for (let e = this.#heads[bucket(x, y)] ?? -1; e >= 0; e = this.#next[e] ?? -1) {
          const other = this.#boxes[this.#box[e] ?? 0];
          if (
            other !== undefined &&
            box.minX <= other.maxX &&
            other.minX <= box.maxX &&
            box.minY <= other.maxY &&
            other.minY <= box.maxY
          )
            return true;
        }
    return false;
  }

  insert(box: MutableBox): void {
    const index = this.#boxes.push(box) - 1;
    const x1 = Math.floor(box.maxX / CELL_PX);
    const y1 = Math.floor(box.maxY / CELL_PX);
    for (let y = Math.floor(box.minY / CELL_PX); y <= y1; y++)
      for (let x = Math.floor(box.minX / CELL_PX); x <= x1; x++) {
        if (this.#entries >= this.#next.length) {
          const next = new Int32Array(this.#next.length * 2);
          next.set(this.#next);
          this.#next = next;
          const boxes = new Int32Array(this.#box.length * 2);
          boxes.set(this.#box);
          this.#box = boxes;
        }
        const b = bucket(x, y);
        this.#box[this.#entries] = index;
        this.#next[this.#entries] = this.#heads[b] ?? -1;
        this.#heads[b] = this.#entries++;
      }
  }
}

function bucket(x: number, y: number): number {
  return (Math.imul(x, 73_856_093) ^ Math.imul(y, 19_349_663)) & (BUCKETS - 1);
}

/** Numbers stored per label read: longitude, latitude, height, size, anchor, offsets x and y, sort key. */
const FIELDS = 8;

/** A label's measured text. */
interface Measured {
  readonly text: string;
  readonly sizePx: number;
  readonly widthPx: number;
  readonly heightPx: number;
}

/** Labels read between two clock reads. */
const CHECK_EVERY = 64;
/**
 * A longer time between two clock reads in a slice is a stall, not placement work: one label takes microseconds, so
 * the thread was descheduled (other threads on a busy CPU, such as a software GPU's) or stopped for a collection.
 */
const STALL_MS = 1;
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
  #boxes: readonly CollisionBox[] = [];
  #pass: Pass | undefined;
  // The labels a pass read, by read index, and their priority order: reused from pass to pass (KB-171).
  #ids: FeatureId[] = [];
  #keys: string[] = [];
  #texts: string[] = [];
  #numbers = new Float64Array(FIELDS * 1024);
  #enabled = new Uint8Array(1024);
  #placed = new Uint8Array(1024);
  readonly #order: number[] = [];
  /** Sort keys of numeric ids, made once. */
  readonly #idKeys = new Map<number, string>();
  /** Two sets of boxes: a pass writes one while the other is the last pass's, which `collisionBoxes` returns. */
  readonly #boxSets: readonly [MutableBox[], MutableBox[]] = [[], []];
  #published = 1;
  readonly #tree = new BoxGrid();
  readonly #position = { longitudeDeg: 0, latitudeDeg: 0, heightMeters: 0 };
  readonly #compare = (a: number, b: number): number => {
    const sa = this.#numbers[a * FIELDS + 7] ?? 0;
    const sb = this.#numbers[b * FIELDS + 7] ?? 0;
    if (sa !== sb) return sa - sb;
    const ka = this.#keys[a] ?? '';
    const kb = this.#keys[b] ?? '';
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };
  /** Frames drawn since the last pass ended: the view may have changed since its decisions. */
  #stale = false;
  #lastPlacementMs = -Infinity;
  #lastFrameMs: number | undefined;
  #forced = true;
  /** Labels still fading toward their last decision: frames are needed until they arrive. */
  #fading = false;
  /** The view a pass last started in (zoom, then the first label's screen point), and whether it changed since. */
  readonly #view = [Number.NaN, Number.NaN, Number.NaN];
  #viewChanged = false;
  /** Placement passes run (instrumentation of collision cost, F359). */
  passes = 0;
  /** Work of the last pass, in milliseconds of wall-clock time, over all its frames. */
  lastPassMs = 0;
  /** The longest placement work done in one frame (the per-frame collision cost, F359). */
  maxFrameMs = 0;
  /** The placement work of the last frames that did any, in milliseconds, oldest first (at most 256). */
  readonly frameMs: number[] = [];
  /** The stalls inside each of those frames' placement work (`STALL_MS`), in milliseconds, in the same order. */
  readonly frameStallMs: number[] = [];
  /** The last clock read of the slice under way, and the stalls it has seen. */
  #tickMs = 0;
  #stallMs = 0;

  constructor(measurer: TextMeasurer, options: PlacementOptions = {}) {
    this.#measurer = measurer;
    this.#intervalMs = options.placementIntervalMs ?? 300;
    this.#fadeMs = options.fadeDurationMs ?? 300;
    this.#paddingPx = options.paddingPx ?? 2;
    this.#budgetMs = options.budgetMs ?? 4;
  }

  /**
   * Whether placement needs frames (ask for one): a pass in progress or forced, labels still fading, or a view that
   * changed since the last pass. Frames drawn for other reasons with the view standing still ask for none, so the
   * engine goes idle (F359).
   */
  get pending(): boolean {
    return this.#pass !== undefined || this.#forced || this.#fading || (this.#stale && this.#viewChanged);
  }

  /** Requests a pass on the next update (labels were added, removed or changed). */
  invalidate(): void {
    this.#pass = undefined;
    this.#forced = true;
  }

  /** Boxes of the last pass; the objects are reused by the pass after next. */
  get collisionBoxes(): readonly CollisionBox[] {
    return this.#boxes;
  }

  /**
   * Advances fades to `nowMs` and runs a placement pass when due. `labels` may return the same input object for every
   * label: each is copied as it is read.
   * @returns whether a pass ran.
   */
  update(nowMs: number, projector: ScreenProjector, labels: () => Iterable<PlacementInput>): boolean {
    let ended = false;
    this.#noteView(projector, labels);
    if (this.#pass === undefined) {
      const due = this.#forced || (this.#stale && nowMs - this.#lastPlacementMs >= this.#intervalMs);
      if (due) {
        this.#pass = this.#start(labels());
        this.#viewChanged = false;
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
    let fading = false;
    for (const state of this.#states.values()) {
      if (state.opacity < state.target) state.opacity = Math.min(state.target, state.opacity + step);
      else if (state.opacity > state.target) state.opacity = Math.max(state.target, state.opacity - step);
      fading ||= state.opacity !== state.target;
    }
    this.#fading = fading;
    return ended;
  }

  /** Notes whether the view differs from the one the last pass started in: its zoom or the first label's position. */
  #noteView(projector: ScreenProjector, labels: () => Iterable<PlacementInput>): void {
    const first = labels()[Symbol.iterator]().next();
    const point = first.done === true ? undefined : projector.geoToScreen(first.value);
    const zoom = projector.zoom();
    const x = point?.xPx ?? Number.NaN;
    const y = point?.yPx ?? Number.NaN;
    const [z0, x0, y0] = this.#view;
    if (!Object.is(z0, zoom) || !Object.is(x0, x) || !Object.is(y0, y)) this.#viewChanged = true;
    this.#view[0] = zoom;
    this.#view[1] = x;
    this.#view[2] = y;
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
    this.#tree.clear();
    return {
      source: labels[Symbol.iterator](),
      count: 0,
      readAll: false,
      sorted: false,
      next: 0,
      boxCount: 0,
      workMs: 0,
    };
  }

  /** Copies a label into the reused arrays at read index `i`. */
  #store(i: number, input: PlacementInput): void {
    if (i >= this.#enabled.length) {
      const numbers = new Float64Array(this.#numbers.length * 2);
      numbers.set(this.#numbers);
      this.#numbers = numbers;
      // The labels read so far keep their switches; `placed` is written by the pass itself.
      const enabled = new Uint8Array(this.#enabled.length * 2);
      enabled.set(this.#enabled);
      this.#enabled = enabled;
      this.#placed = new Uint8Array(this.#placed.length * 2);
    }
    const id = input.id;
    let key = typeof id === 'string' ? id : this.#idKeys.get(id);
    if (key === undefined) {
      if (this.#idKeys.size >= MEASURE_CACHE) this.#idKeys.clear();
      key = String(id);
      this.#idKeys.set(id as number, key);
    }
    this.#ids[i] = id;
    this.#keys[i] = key;
    this.#texts[i] = input.text;
    const o = i * FIELDS;
    const n = this.#numbers;
    n[o] = input.longitudeDeg;
    n[o + 1] = input.latitudeDeg;
    n[o + 2] = input.heightMeters;
    n[o + 3] = input.sizePx;
    n[o + 4] = input.anchor;
    n[o + 5] = input.offsetXEm;
    n[o + 6] = input.offsetYEm;
    n[o + 7] = input.sortKey;
    this.#enabled[i] = input.enabled ? 1 : 0;
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
        this.#store(pass.count++, next.value);
        if (n % CHECK_EVERY === 0 && this.#tick() >= deadline) return false;
      }
    const order = this.#order;
    for (let i = 0; i < pass.count; i++) order[i] = i;
    order.length = pass.count;
    order.sort(this.#compare);
    pass.sorted = true;
    return true;
  }

  /** Places labels until the pass ends or this frame's budget is spent; at the end, applies its decisions. */
  #continue(pass: Pass, projector: ScreenProjector): boolean {
    const started = performance.now();
    this.#tickMs = started;
    this.#stallMs = 0;
    const deadline = started + this.#budgetMs;
    const sorted = pass.sorted || this.#read(pass, deadline);
    const tree = this.#tree;
    const order = this.#order;
    const boxes = this.#boxSets[1 - this.#published] as MutableBox[];
    while (sorted && pass.next < pass.count && this.#tick() < deadline) {
      const i = order[pass.next++] ?? 0;
      this.#placed[i] = 0;
      if (this.#enabled[i] === 0) continue;
      let box = boxes[pass.boxCount];
      if (box === undefined) {
        box = { id: 0, minX: 0, minY: 0, maxX: 0, maxY: 0, placed: false };
        boxes[pass.boxCount] = box;
      }
      if (!this.#box(i, projector, box)) continue;
      pass.boxCount++;
      box.placed = !tree.collides(box);
      if (box.placed) {
        tree.insert(box);
        this.#placed[i] = 1;
      }
    }
    const frameMs = performance.now() - started;
    this.maxFrameMs = Math.max(this.maxFrameMs, frameMs);
    if (this.frameMs.push(frameMs) > 256) this.frameMs.shift();
    if (this.frameStallMs.push(this.#stallMs) > 256) this.frameStallMs.shift();
    pass.workMs += frameMs;
    if (!sorted || pass.next < pass.count) return false;
    for (let i = 0; i < pass.count; i++) {
      const id = this.#ids[i] ?? 0;
      let state = this.#states.get(id);
      if (state === undefined) {
        state = { opacity: 0, target: 0 };
        this.#states.set(id, state);
      }
      state.target = this.#placed[i] ?? 0;
    }
    // Labels no longer read (fewer than last time) release their references.
    this.#ids.length = this.#keys.length = this.#texts.length = pass.count;
    boxes.length = pass.boxCount;
    this.#boxes = boxes;
    this.#published = 1 - this.#published;
    this.#pass = undefined;
    this.passes += 1;
    this.lastPassMs = pass.workMs;
    return true;
  }

  /** Reads the clock, counting the time since the last read as a stall when it exceeds `STALL_MS`. */
  #tick(): number {
    const now = performance.now();
    if (now - this.#tickMs > STALL_MS) this.#stallMs += now - this.#tickMs;
    this.#tickMs = now;
    return now;
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

  /** Writes the screen box of the label at read index `i` into `box`; false when it is hidden or has no text. */
  #box(i: number, projector: ScreenProjector, box: MutableBox): boolean {
    const n = this.#numbers;
    const o = i * FIELDS;
    const position = this.#position;
    position.longitudeDeg = n[o] ?? 0;
    position.latitudeDeg = n[o + 1] ?? 0;
    position.heightMeters = n[o + 2] ?? 0;
    const point = projector.geoToScreen(position);
    const id = this.#ids[i] ?? 0;
    const text = this.#texts[i] ?? '';
    if (point === undefined || text.length === 0) return false;
    const sizePx = n[o + 3] ?? 0;
    const { widthPx, heightPx } = this.#measure(id, text, sizePx);
    const shift = ANCHOR_SHIFT[n[o + 4] ?? 0] ?? ANCHOR_SHIFT[0];
    box.id = id;
    box.minX = point.xPx + (shift?.[0] ?? -0.5) * widthPx + (n[o + 5] ?? 0) * sizePx - this.#paddingPx;
    box.minY = point.yPx + (shift?.[1] ?? -0.5) * heightPx + (n[o + 6] ?? 0) * sizePx - this.#paddingPx;
    box.maxX = box.minX + widthPx + 2 * this.#paddingPx;
    box.maxY = box.minY + heightPx + 2 * this.#paddingPx;
    box.placed = false;
    return true;
  }
}
