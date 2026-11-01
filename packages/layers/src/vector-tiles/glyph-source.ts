// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Glyphs and sprites of a style for labels (F448, ADR 0132): glyph ranges fetched from the style's `glyphs` URL only
 * for the code points labels use, per font stack; characters no range has are drawn locally in a configured font
 * family when the target can rasterize (CJK fallback), else left out (no missing-glyph boxes); the sprite sheet at
 * the device pixel ratio (`@2x` from ratio 1.5 on), its icons cut out as RGBA.
 */
import {
  decodeGlyphRange,
  glyphUrl,
  GlyphStore,
  parseSpriteIndex,
  spriteUrls,
  type Glyph,
  type SpriteIcon,
} from './glyphs.js';
import type { VectorTileTarget } from './vector-target.js';

/** The font stack name of locally drawn glyphs. */
export const LOCAL_FONT_STACK = 'local';

/** A font name's weight, by the word that names it (the first that matches). */
const WEIGHTS: readonly (readonly [RegExp, number])[] = [
  [/black|heavy/, 900],
  [/(extra|ultra) ?bold/, 800],
  [/(semi|demi) ?bold/, 600],
  [/bold/, 700],
  [/medium/, 500],
  [/(extra|ultra) ?light/, 200],
  [/light/, 300],
  [/thin|hairline/, 100],
];

/** The CSS font style and weight of a font stack, read from its first font's name ("Noto Sans Bold Italic"). */
export function fontOfStack(fontStack: readonly string[]): string {
  const name = (fontStack[0] ?? '').toLowerCase();
  const weight = String(WEIGHTS.find(([word]) => word.test(name))?.[1] ?? 400);
  return /italic|oblique/.test(name) ? `italic ${weight}` : weight;
}

/** A glyph range that failed on the way is requested again after this long. */
const GLYPH_RETRY_MS = 5_000;
/**
 * Answers that do not decode before a range is kept as what decoded (KB-226): a server answering a range it does not
 * have with a page (a 200 that is not a glyph file) leaves its characters to the local font instead of a wait forever.
 */
const DAMAGED_ROUNDS = 5;

/** An icon of the sprite: its pixels and the pixel ratio they were drawn for. */
export interface SpriteImage {
  readonly icon: SpriteIcon;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8ClampedArray;
}

/** Loads glyph ranges and the sprite; calls `onChange` when something new arrived. */
export class GlyphSource {
  readonly store = new GlyphStore();
  private readonly pending = new Set<string>();
  /** Answers of a range that did not decode: fetched again past the HTTP cache, which may hold them (KB-226). */
  private readonly damaged = new Map<string, number>();
  /** Ranges requested and not arrived, those waiting to be requested again included. */
  private readonly unsettled = new Set<string>();
  private readonly localTried = new Set<number | string>();
  private icons = new Map<string, SpriteImage>();
  /** The pixel ratio of the sprite loaded (1 or 2). */
  spriteRatio = 1;
  /** True while the sprite loads: a label waits for its icon then, and draws its text alone once it has failed. */
  spriteLoading = false;

  constructor(
    private readonly glyphs: string | undefined,
    private readonly fetchImpl: typeof fetch,
    private readonly onChange: () => void,
    private readonly target: Pick<VectorTileTarget, 'rasterizeGlyphs'>,
    private readonly localFontFamily: string | undefined,
    private readonly pageFontFamily?: string,
  ) {}

  /** Glyph ranges requested and not arrived yet, those that failed and wait to be requested again included. */
  get loading(): number {
    return this.unsettled.size;
  }

  /** The glyph of a code point from the first font stack that has it, then the local font. */
  resolve(code: number, fontStack: readonly string[]): { glyph: Glyph; fontStack: string } | undefined {
    return this.store.resolve(code, [fontStack, [LOCAL_FONT_STACK]]);
  }

  /** Requests the ranges `text` needs in `fontStack` that are not loaded or loading. */
  need(fontStack: readonly string[], text: string): void {
    if (this.glyphs === undefined || this.pageFontFamily !== undefined) return;
    for (const start of this.store.missingRanges(fontStack, text)) {
      const url = new URL(glyphUrl(this.glyphs, fontStack, start), globalThis.location?.href).href;
      if (this.pending.has(url)) continue;
      this.pending.add(url);
      this.unsettled.add(url);
      void this.fetchImpl(url, this.damaged.has(url) ? { cache: 'reload' } : undefined)
        .then(async (response) => {
          // A missing range (404 and the like, or a page a server answers in its place) has no glyphs; a server
          // error is retried like a network failure.
          if (response.status >= 500) throw new Error(`glyph range answered ${String(response.status)}`);
          const page = response.headers.get('content-type')?.includes('text/html') === true;
          return response.ok && !page ? new Uint8Array(await response.arrayBuffer()) : new Uint8Array(0);
        })
        .then((bytes) => {
          const range = decodeGlyphRange(bytes);
          const damaged = range.intact ? 0 : (this.damaged.get(url) ?? 0) + 1;
          if (damaged > 0 && damaged < DAMAGED_ROUNDS) {
            this.damaged.set(url, damaged);
            throw new Error('glyph range damaged on the way');
          }
          this.damaged.delete(url);
          this.unsettled.delete(url);
          this.store.add(fontStack, start, range.glyphs);
          this.onChange();
        })
        // A range that failed on the way, or whose bytes were cut or damaged, is not kept as empty: the labels wait
        // for it, and it is requested again later (TG-04, KB-226).
        .catch(() => setTimeout(() => this.retry(url), GLYPH_RETRY_MS));
    }
  }

  /**
   * Whether every range `text` needs in `fontStack` has arrived; characters still missing then are drawn locally
   * (once each) when a local font family is configured.
   */
  ready(fontStack: readonly string[], text: string): boolean {
    if (this.pageFontFamily !== undefined) return this.drawInPageFont(fontStack, text);
    if (this.glyphs !== undefined && this.store.missingRanges(fontStack, text).length > 0) return false;
    if (this.localFontFamily === undefined || this.target.rasterizeGlyphs === undefined) return true;
    const missing: number[] = [];
    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;
      if (code > 0x20 && this.resolve(code, fontStack) === undefined && !this.localTried.has(code)) missing.push(code);
    }
    if (missing.length > 0) {
      for (const code of missing) this.localTried.add(code);
      const glyphs = this.target.rasterizeGlyphs('400', this.localFontFamily, missing);
      this.store.add(
        [LOCAL_FONT_STACK],
        -1,
        new Map(glyphs.map((g) => [g.id, { ...g, bitmap: Uint8Array.from(g.bitmap) }])),
      );
    }
    return true;
  }

  /** Draws the characters of `text` the font stack lacks in the page's font, with the stack's weight and style. */
  private drawInPageFont(fontStack: readonly string[], text: string): boolean {
    const family = this.pageFontFamily;
    if (family === undefined || this.target.rasterizeGlyphs === undefined) return true;
    const key = fontStack.join(',');
    const missing: number[] = [];
    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;
      const tried = `${key}#${String(code)}`;
      if (code > 0x20 && !this.localTried.has(tried)) {
        this.localTried.add(tried);
        missing.push(code);
      }
    }
    if (missing.length === 0) return true;
    const glyphs = this.target.rasterizeGlyphs(fontOfStack(fontStack), family, missing);
    this.store.add(fontStack, -1, new Map(glyphs.map((g) => [g.id, { ...g, bitmap: Uint8Array.from(g.bitmap) }])));
    return true;
  }

  /** Lets a failed range be requested again by the next labels that need it. */
  private retry(url: string): void {
    this.pending.delete(url);
    this.unsettled.delete(url);
    this.onChange();
  }

  /** An icon of the sprite, once loaded. */
  icon(name: string): SpriteImage | undefined {
    return this.icons.get(name);
  }

  /** Loads the sprite for a device pixel ratio. */
  async loadSprite(
    sprite: string | readonly { readonly id: string; readonly url: string }[] | undefined,
    pixelRatio: number,
  ): Promise<void> {
    if (sprite === undefined) return;
    this.spriteLoading = true;
    this.spriteRatio = pixelRatio >= 1.5 ? 2 : 1;
    const icons = new Map<string, SpriteImage>();
    for (const sheet of spriteUrls(sprite, this.spriteRatio)) {
      try {
        const base = globalThis.location?.href;
        const index = parseSpriteIndex(await (await this.fetchImpl(new URL(sheet.json, base).href)).json(), sheet.id);
        const image = await createImageBitmap(await (await this.fetchImpl(new URL(sheet.png, base).href)).blob());
        const canvas = new OffscreenCanvas(image.width, image.height);
        const ctx = canvas.getContext('2d');
        if (ctx === null) continue;
        ctx.drawImage(image, 0, 0);
        for (const [name, icon] of index) {
          const pixels = ctx.getImageData(icon.x, icon.y, icon.width, icon.height).data;
          icons.set(name, { icon, width: icon.width, height: icon.height, pixels });
        }
      } catch {
        // A sprite that fails to load leaves its icons out; labels still draw their text.
      }
    }
    this.icons = icons;
    this.spriteLoading = false;
    this.onChange();
  }
}
