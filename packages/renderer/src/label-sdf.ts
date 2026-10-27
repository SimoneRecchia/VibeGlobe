// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Signed distance field text of data-layer labels (F358, ADR 0045): each label's text is rasterized once, at a
 * reference size, with the browser's fonts and shaping (so every script the page can show draws, ligatures and
 * right-to-left text included), turned into a distance field in a worker, and cached in an {@link SdfAtlas}. One entry
 * serves every size, color, halo and pixel ratio: the shader draws the outline from the field, crisp at any scale.
 */
import { SdfAtlas, type AtlasRect } from './vector-tiles/sdf-atlas.js';
import { sdfFromCoverage } from './vector-tiles/local-glyphs.js';
import type { SdfReply, SdfRequest } from './label-sdf-worker.js';

/**
 * The size a label of `sizePx` is rasterized at, CSS pixels: 12 below 14 px, whose thin strokes scaled down from a
 * larger field shimmer as they move (F360), and 16 above, whose detail a 12 px field loses (a CJK glyph's end strokes,
 * F357). Entries scale by `sizePx / labelReferencePx(sizePx)`.
 */
export function labelReferencePx(sizePx: number): number {
  return sizePx < 14 ? 12 : 16;
}
/** Field units per texel (`sdfFromCoverage`: radius 8 texels, 0.75 at the outline). */
export const SDF_UNITS_PER_TEXEL = 1 / 8;
/** Texels around the text, at the reference size: the widest halo the field reaches (0.75 / ⅛ = 6 texels). */
export const LABEL_BUFFER_TEXELS = 6;
/** How long replies from the worker are collected before they are added to the atlas together. */
const FLUSH_MS = 50;
/** Collision boxes reach this far around the text, CSS pixels. */
const BOX_PAD_PX = 3;
/** A label's line height, in ems. */
const LINE_HEIGHT = 1.3;
/** The fonts after a label's own: the system's, which carry the scripts a font lacks (Greek, Cyrillic, CJK). */
const LABEL_FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", Arial, sans-serif';

type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function createContext(): Canvas2D | undefined {
  const canvas =
    typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(64, 64)
      : typeof document === 'object'
        ? Object.assign(document.createElement('canvas'), { width: 64, height: 64 })
        : undefined;
  return (canvas?.getContext('2d', { willReadFrequently: true }) as Canvas2D | null | undefined) ?? undefined;
}

/** Starts the worker, or undefined where workers cannot start (tests, a page whose policy forbids them). */
function startWorker(): Worker | undefined {
  if (typeof Worker !== 'function') return undefined;
  try {
    // The literal form, so bundlers find and emit the worker entry (ADR 0011 rule 5).
    return new Worker(new URL('./label-sdf-worker.js', import.meta.url), { type: 'module', name: 'vibeglobe-labels' });
  } catch {
    return undefined;
  }
}

/** Distance fields of label texts, generated off the main thread and cached in one atlas. */
export class LabelSdf {
  readonly atlas: SdfAtlas;
  /** Fields generated in the worker and on the calling thread (where no worker starts), for instrumentation. */
  readonly generated = { worker: 0, inline: 0 };
  /** Increases each time entries arrive: labels waiting for them are drawn. */
  private version = 0;
  private readonly context: Canvas2D | undefined;
  private measureFont = '';
  private worker: Worker | undefined | null;
  /** Texts sent to the worker and not in the atlas yet, kept to finish them here if the worker fails. */
  private readonly pending = new Map<string, { text: string; font: string; reference: number }>();
  /** Replies waiting to be added: together, so the atlas texture is uploaded once per batch, not per reply. */
  private readonly replies: SdfReply[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private listener: (() => void) | undefined;

  constructor(atlasSize = 4096) {
    // One channel, 4096 texels: the memory of a 2048 RGBA atlas (16 MB), about 8,000 short labels at 16 px.
    this.atlas = new SdfAtlas(atlasSize, 1);
    this.context = createContext();
  }

  /** Changes when fields arrive or the atlas starts over (entries handed out before are stale). */
  get revision(): number {
    return this.version + this.atlas.generation;
  }

  /** Whether fields are being generated: labels wait for them, so the engine keeps drawing until they arrive. */
  get generating(): boolean {
    return this.pending.size > 0;
  }

  /** Called when fields generated off the frame have been added to the atlas. */
  onReady(listener: () => void): void {
    this.listener = listener;
  }

  /**
   * The collision box of a text at a size, CSS pixels (F359): its advance and line height with {@link BOX_PAD_PX} on
   * every side (room for a halo of 2 px), without generating its field. The drawn quad is larger: it holds the
   * field's buffer, which the halo and the text's anti-aliasing never fill.
   */
  measure(text: string, sizePx: number, font: string): { widthPx: number; heightPx: number } {
    const reference = labelReferencePx(sizePx);
    const { width } = this.texels(text, font, reference);
    const scale = sizePx / reference;
    return {
      widthPx: (width - 2 * LABEL_BUFFER_TEXELS) * scale + 2 * BOX_PAD_PX,
      heightPx: sizePx * LINE_HEIGHT + 2 * BOX_PAD_PX,
    };
  }

  /**
   * The atlas rect (texels) of a text's field, or undefined while it is generated (requested on the first call) or
   * where it cannot be (no canvas, wider than the atlas).
   */
  entry(text: string, font: string, reference: number): AtlasRect | undefined {
    const key = `${String(reference)}\n${font}\n${text}`;
    const cached = this.atlas.get(key);
    if (cached || this.pending.has(key) || !this.context) return cached;
    const request = this.rasterize(key, text, font, reference);
    if (!request) return undefined;
    if (this.worker === undefined) this.worker = this.connect();
    if (this.worker) {
      // The text stays here, to draw it again here if the worker fails.
      this.pending.set(key, { text, font, reference });
      this.worker.postMessage(request, [request.coverage.buffer]);
      return undefined;
    }
    return this.generateHere(key, text, font, reference, request);
  }

  /**
   * A text's field as a label quad at a size: atlas coordinates (0–1) and its size in CSS pixels, or undefined while
   * it is generated ({@link entry}).
   */
  quad(
    text: string,
    sizePx: number,
    font: string,
  ): { u0: number; v0: number; u1: number; v1: number; widthPx: number; heightPx: number } | undefined {
    const reference = labelReferencePx(sizePx);
    const rect = this.entry(text, font, reference);
    if (!rect) return undefined;
    const size = this.atlas.size;
    const scale = sizePx / reference;
    return {
      u0: rect.x / size,
      v0: rect.y / size,
      u1: (rect.x + rect.width) / size,
      v1: (rect.y + rect.height) / size,
      widthPx: rect.width * scale,
      heightPx: rect.height * scale,
    };
  }

  /** Stops the worker and frees the atlas. */
  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.replies.length = 0;
    this.pending.clear();
    this.atlas.dispose();
  }

  private texels(text: string, font: string, reference: number): { width: number; height: number } {
    const context = this.context;
    const css = `${String(reference)}px ${font ? `${font}, ` : ''}${LABEL_FONT}`;
    // Parsing a font is slower than measuring: labels of one layer share theirs.
    if (context && css !== this.measureFont) context.font = this.measureFont = css;
    const advance = context ? context.measureText(text).width : text.length * reference * 0.6;
    return {
      width: Math.ceil(advance) + 2 * LABEL_BUFFER_TEXELS,
      height: Math.ceil(reference * LINE_HEIGHT) + 2 * LABEL_BUFFER_TEXELS,
    };
  }

  /** The coverage of a text at the reference size, with the buffer around it. */
  private rasterize(key: string, text: string, font: string, reference: number): SdfRequest | undefined {
    const context = this.context;
    if (!context) return undefined;
    const { width, height } = this.texels(text, font, reference);
    if (width + 2 > this.atlas.size || height + 2 > this.atlas.size) return undefined;
    const canvas = context.canvas;
    if (canvas.width < width || canvas.height < height) {
      canvas.width = Math.max(canvas.width, width);
      canvas.height = Math.max(canvas.height, height);
    }
    // Resizing resets the context's state.
    context.font = this.measureFont = `${String(reference)}px ${font ? `${font}, ` : ''}${LABEL_FONT}`;
    context.clearRect(0, 0, width, height);
    context.textBaseline = 'middle';
    context.textAlign = 'left';
    context.fillStyle = 'black';
    context.fillText(text, LABEL_BUFFER_TEXELS, height / 2);
    return { key, coverage: context.getImageData(0, 0, width, height).data, width, height };
  }

  private connect(): Worker | null {
    const worker = startWorker();
    if (!worker) return null;
    worker.onmessage = (event: MessageEvent<SdfReply>) => {
      this.replies.push(event.data);
      // Neither backend uploads part of a texture: replies of the next FLUSH_MS go into the atlas together.
      this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_MS);
    };
    worker.onerror = () => {
      // The worker failed to start or run: finish what it held here, and generate here from now on.
      worker.terminate();
      this.worker = null;
      clearTimeout(this.flushTimer);
      this.flush();
      for (const [key, { text, font, reference }] of this.pending) this.generateHere(key, text, font, reference);
      this.pending.clear();
      this.arrived();
    };
    return worker;
  }

  /** Generates a field on this thread (no worker, or the worker failed) and adds it. */
  private generateHere(
    key: string,
    text: string,
    font: string,
    reference: number,
    request = this.rasterize(key, text, font, reference),
  ): AtlasRect | undefined {
    if (!request) return undefined;
    this.generated.inline++;
    return this.atlas.addSdf(
      key,
      sdfFromCoverage(request.coverage, request.width, request.height),
      request.width,
      request.height,
    );
  }

  /** Adds the waiting replies to the atlas and asks for a frame. */
  private flush(): void {
    this.flushTimer = undefined;
    for (const { key, bitmap, width, height } of this.replies) {
      if (!this.pending.delete(key)) continue;
      this.generated.worker++;
      this.atlas.addSdf(key, bitmap, width, height);
    }
    this.replies.length = 0;
    this.arrived();
  }

  private arrived(): void {
    this.version++;
    this.listener?.();
  }
}

/**
 * The features of batches waiting for label fields (F358): when fields arrive they are rewritten in place, not their
 * whole batch rebuilt (a rebuild of 10,000 labels per arrival allocates enough to stall the frame); when the atlas
 * starts over every label batch is rebuilt.
 */
export class FieldWaits<B> {
  /** The batch being built or rewritten, whose features {@link note} records. */
  current: B | undefined;
  private readonly waits = new Map<B, number[]>();
  private revision = 0;
  private generation = 0;

  /** Records that a feature of the current batch waits for its field; returns undefined, its field for now. */
  note(feature: number): undefined {
    const batch = this.current;
    if (batch === undefined) return undefined;
    const list = this.waits.get(batch);
    if (list) list.push(feature);
    else this.waits.set(batch, [feature]);
    return undefined;
  }

  /** After fields arrived: `rewrite` for each waiting feature, or `rebuildAll` when the atlas started over. */
  settle(labels: LabelSdf, rewrite: (batch: B, feature: number) => void, rebuildAll: () => void): void {
    if (labels.revision === this.revision) return;
    this.revision = labels.revision;
    if (labels.atlas.generation !== this.generation) {
      this.generation = labels.atlas.generation;
      this.waits.clear();
      rebuildAll();
      return;
    }
    for (const [batch, features] of this.waits) for (const feature of features) rewrite(batch, feature);
    this.waits.clear();
  }
}
