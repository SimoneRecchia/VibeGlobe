/**
 * Glyphs and sprites of a style (F448): glyph-range URLs requested only for the code points a label uses, the glyph
 * PBF format (signed-distance-field bitmaps with metrics, 256 code points per range), font-stack fallback, and sprite
 * URLs and index sheets at 1x and 2x. Decoding runs in workers; the renderer uploads the bitmaps to its atlas.
 */
import { PbfReader } from 'pbf';

/** Code points per glyph range file. */
export const GLYPH_RANGE_SIZE = 256;
/** Highest code point a glyph range may hold (the Basic Multilingual Plane, as glyph servers serve). */
export const MAX_GLYPH_CODE_POINT = 0xffff;

/** One glyph: its SDF bitmap (width + 6 by height + 6, a 3-pixel border) and metrics in pixels at 24 px. */
export interface Glyph {
  readonly id: number;
  readonly bitmap: Uint8Array<ArrayBufferLike>;
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly advance: number;
}

/** The start code points of the ranges `text` needs, sorted (each range is `start`–`start + 255`). */
export function glyphRanges(text: string): number[] {
  const starts = new Set<number>();
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= MAX_GLYPH_CODE_POINT) starts.add(Math.floor(code / GLYPH_RANGE_SIZE) * GLYPH_RANGE_SIZE);
  }
  return [...starts].sort((a, b) => a - b);
}

/** The URL of one glyph range from the style's `glyphs` template (`{fontstack}` and `{range}`). */
export function glyphUrl(template: string, fontStack: readonly string[], start: number): string {
  return template
    .replace('{fontstack}', encodeURIComponent(fontStack.join(',')))
    .replace('{range}', `${start}-${start + GLYPH_RANGE_SIZE - 1}`);
}

function readGlyph(pbf: PbfReader, end: number): Glyph {
  const glyph: { -readonly [K in keyof Glyph]: Glyph[K] } = {
    id: 0,
    bitmap: new Uint8Array(0),
    width: 0,
    height: 0,
    left: 0,
    top: 0,
    advance: 0,
  };
  pbf.readFields(
    (tag) => {
      if (tag === 1) glyph.id = pbf.readVarint();
      else if (tag === 2) glyph.bitmap = pbf.readBytes();
      else if (tag === 3) glyph.width = pbf.readVarint();
      else if (tag === 4) glyph.height = pbf.readVarint();
      else if (tag === 5) glyph.left = pbf.readSVarint();
      else if (tag === 6) glyph.top = pbf.readSVarint();
      else if (tag === 7) glyph.advance = pbf.readVarint();
    },
    undefined,
    end,
  );
  return glyph;
}

/**
 * Decodes a glyph range file (the `glyphs.proto` format of the style specification's glyph servers).
 * @returns the glyphs by code point; an empty map when the bytes are not a glyph file. Never throws.
 */
export function decodeGlyphs(bytes: Uint8Array): Map<number, Glyph> {
  const glyphs = new Map<number, Glyph>();
  try {
    const pbf = new PbfReader(bytes);
    pbf.readFields((tag) => {
      if (tag !== 1) return;
      const stackEnd = pbf.readVarint() + pbf.pos;
      pbf.readFields(
        (field) => {
          if (field !== 3) return;
          const glyph = readGlyph(pbf, pbf.readVarint() + pbf.pos);
          const expected = (glyph.width > 0 ? glyph.width + 6 : 0) * (glyph.height > 0 ? glyph.height + 6 : 0);
          if (glyph.bitmap.length === expected || glyph.bitmap.length === 0) glyphs.set(glyph.id, glyph);
        },
        undefined,
        stackEnd,
      );
    }, undefined);
  } catch {
    glyphs.clear();
  }
  return glyphs;
}

/** Glyphs loaded so far, per font stack name (`'Open Sans Regular,Arial Unicode MS Regular'`). */
export class GlyphStore {
  private readonly stacks = new Map<string, Map<number, Glyph>>();
  private readonly loaded = new Set<string>();

  /** Adds a decoded range for a font stack. */
  add(fontStack: readonly string[], start: number, glyphs: ReadonlyMap<number, Glyph>): void {
    const key = fontStack.join(',');
    let stack = this.stacks.get(key);
    if (stack === undefined) this.stacks.set(key, (stack = new Map()));
    for (const [code, glyph] of glyphs) stack.set(code, glyph);
    this.loaded.add(`${key}#${start}`);
  }

  /** The ranges of `text` not loaded yet for a font stack (what to request next). */
  missingRanges(fontStack: readonly string[], text: string): number[] {
    const key = fontStack.join(',');
    return glyphRanges(text).filter((start) => !this.loaded.has(`${key}#${start}`));
  }

  /**
   * The glyph for a code point from the first font stack that has it (the style's stack, then the configured
   * fallbacks); undefined when none has it, so the label leaves the character out instead of drawing a missing box.
   */
  resolve(code: number, fontStacks: readonly (readonly string[])[]): { glyph: Glyph; fontStack: string } | undefined {
    for (const fontStack of fontStacks) {
      const key = fontStack.join(',');
      const glyph = this.stacks.get(key)?.get(code);
      if (glyph !== undefined) return { glyph, fontStack: key };
    }
    return undefined;
  }
}

/** One sprite sheet to load: its id (empty for a single sprite) and the index and image URLs. */
export interface SpriteSheetUrls {
  readonly id: string;
  readonly json: string;
  readonly png: string;
}

function withSuffix(url: string, suffix: string): string {
  const query = url.indexOf('?');
  return query < 0 ? `${url}${suffix}` : `${url.slice(0, query)}${suffix}${url.slice(query)}`;
}

/** The sprite URLs for a device pixel ratio: the `@2x` sheets above ratio 1, as the style specification defines. */
export function spriteUrls(
  sprite: string | readonly { readonly id: string; readonly url: string }[],
  pixelRatio: number,
): SpriteSheetUrls[] {
  const ratio = pixelRatio > 1 ? '@2x' : '';
  const sheets = typeof sprite === 'string' ? [{ id: '', url: sprite }] : sprite;
  return sheets.map(({ id, url }) => ({
    id,
    json: withSuffix(url, `${ratio}.json`),
    png: withSuffix(url, `${ratio}.png`),
  }));
}

/** One icon of a sprite sheet. */
export interface SpriteIcon {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  readonly sdf: boolean;
}

/**
 * Parses a sprite index; icons of sheets with an id are named `id:name` (style specification 26.x). Entries with
 * invalid fields are left out.
 */
export function parseSpriteIndex(json: unknown, sheetId = ''): Map<string, SpriteIcon> {
  const icons = new Map<string, SpriteIcon>();
  if (json === null || typeof json !== 'object') return icons;
  for (const [name, value] of Object.entries(json as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    const numbers = [v['x'], v['y'], v['width'], v['height']];
    if (!numbers.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) continue;
    icons.set(sheetId === '' ? name : `${sheetId}:${name}`, {
      x: v['x'] as number,
      y: v['y'] as number,
      width: v['width'] as number,
      height: v['height'] as number,
      pixelRatio: typeof v['pixelRatio'] === 'number' ? v['pixelRatio'] : 1,
      sdf: v['sdf'] === true,
    });
  }
  return icons;
}
