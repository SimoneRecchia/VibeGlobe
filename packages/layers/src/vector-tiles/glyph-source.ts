/**
 * Glyphs and sprites of a style for labels (F448, ADR 0132): glyph ranges fetched from the style's `glyphs` URL only
 * for the code points labels use, per font stack; characters no range has are drawn locally in a configured font
 * family when the target can rasterize (CJK fallback), else left out (no missing-glyph boxes); the sprite sheet at
 * the device pixel ratio (`@2x` from ratio 1.5 on), its icons cut out as RGBA.
 */
import {
  decodeGlyphs,
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
  /** Glyph range URLs requested so far (tests: F448). */
  readonly requested: string[] = [];
  private readonly pending = new Set<string>();
  private readonly localTried = new Set<number>();
  private icons = new Map<string, SpriteImage>();
  /** The pixel ratio of the sprite loaded (1 or 2). */
  spriteRatio = 1;

  constructor(
    private readonly glyphs: string | undefined,
    private readonly fetchImpl: typeof fetch,
    private readonly onChange: () => void,
    private readonly target: Pick<VectorTileTarget, 'rasterizeGlyphs'>,
    private readonly localFontFamily: string | undefined,
  ) {}

  /** The glyph of a code point from the first font stack that has it, then the local font. */
  resolve(code: number, fontStack: readonly string[]): { glyph: Glyph; fontStack: string } | undefined {
    return this.store.resolve(code, [fontStack, [LOCAL_FONT_STACK]]);
  }

  /** Requests the ranges `text` needs in `fontStack` that are not loaded or loading. */
  need(fontStack: readonly string[], text: string): void {
    if (this.glyphs === undefined) return;
    for (const start of this.store.missingRanges(fontStack, text)) {
      const url = new URL(glyphUrl(this.glyphs, fontStack, start), globalThis.location?.href).href;
      if (this.pending.has(url)) continue;
      this.pending.add(url);
      this.requested.push(url);
      void this.fetchImpl(url)
        .then(async (response) => (response.ok ? new Uint8Array(await response.arrayBuffer()) : new Uint8Array(0)))
        .catch(() => new Uint8Array(0))
        .then((bytes) => {
          this.store.add(fontStack, start, decodeGlyphs(bytes));
          this.onChange();
        });
    }
  }

  /**
   * Whether every range `text` needs in `fontStack` has arrived; characters still missing then are drawn locally
   * (once each) when a local font family is configured.
   */
  ready(fontStack: readonly string[], text: string): boolean {
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
    this.onChange();
  }
}
