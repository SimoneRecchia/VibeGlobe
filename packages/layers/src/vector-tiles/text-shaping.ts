/**
 * Text shaping for symbol layers (F448, F449), original code (ADR 0034): glyphs laid out from their advances at the
 * glyph servers' 24 px em, lines broken at `text-max-width` at spaces and at ideographic break opportunities (CJK has
 * no spaces), justified and anchored as the style specification defines. Characters no font stack has are left out
 * and reported, so no missing-glyph box is drawn. Right-to-left and complex scripts are a follow-up (ADR 0034).
 */
import type { Glyph } from './glyphs.js';

/** The em size of glyph metrics, in pixels. */
export const ONE_EM_PX = 24;

/** `text-anchor` values. */
export type TextAnchor =
  'center' | 'left' | 'right' | 'top' | 'bottom' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/** Layout properties the shaper reads, in ems (as the style specification gives them). */
export interface ShapingOptions {
  /** `text-max-width` in ems (default 10); 0 disables wrapping (line labels). */
  readonly maxWidthEm: number;
  /** `text-line-height` in ems (default 1.2). */
  readonly lineHeightEm: number;
  /** `text-letter-spacing` in ems (default 0). */
  readonly letterSpacingEm: number;
  /** `text-justify` (default center); `auto` follows the anchor. */
  readonly justify: 'left' | 'center' | 'right' | 'auto';
  readonly anchor: TextAnchor;
  /** `text-offset` in ems. */
  readonly offsetEm: readonly [number, number];
}

/** Defaults of the style specification. */
export const DEFAULT_SHAPING: ShapingOptions = {
  maxWidthEm: 10,
  lineHeightEm: 1.2,
  letterSpacingEm: 0,
  justify: 'center',
  anchor: 'center',
  offsetEm: [0, 0],
};

/** One placed glyph, its origin in pixels at 24 px relative to the label anchor (y down). */
export interface PositionedGlyph {
  readonly code: number;
  readonly x: number;
  readonly y: number;
  readonly line: number;
  readonly fontStack: string;
  readonly glyph: Glyph;
}

/** A shaped label. */
export interface Shaping {
  readonly glyphs: readonly PositionedGlyph[];
  readonly lineCount: number;
  /** The text box relative to the anchor, in pixels at 24 px; scale by `text-size / 24`. */
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  /** Code points no font stack had (not drawn). */
  readonly missing: readonly number[];
}

/** Looks a code point up across the font stacks (`GlyphStore.resolve`). */
export type GlyphLookup = (code: number) => { glyph: Glyph; fontStack: string } | undefined;

/** Whether a line may break after this code point without a space (ideographs, kana, Hangul, full-width forms). */
export function allowsIdeographicBreak(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x20000 && code <= 0x2fa1f)
  );
}

interface Item {
  readonly code: number;
  readonly advance: number;
  readonly resolved: ReturnType<GlyphLookup>;
}

/** Splits items into lines no wider than `maxWidth` (greedy, breaking at spaces and ideographic opportunities). */
function breakLines(items: readonly Item[], maxWidth: number): Item[][] {
  if (maxWidth <= 0) return [items.slice()];
  const lines: Item[][] = [];
  let line: Item[] = [];
  let width = 0;
  let breakAt = -1;
  for (const item of items) {
    if (item.code === 0x0a) {
      lines.push(line);
      line = [];
      width = 0;
      breakAt = -1;
      continue;
    }
    line.push(item);
    width += item.advance;
    // Break at the last opportunity before this item, so the item starts the next line when it overflows.
    if (width > maxWidth && breakAt > 0 && breakAt < line.length) {
      lines.push(line.slice(0, breakAt));
      line = line.slice(breakAt);
      width = line.reduce((sum, i) => sum + i.advance, 0);
      breakAt = -1;
    }
    if (item.code === 0x20 || allowsIdeographicBreak(item.code)) breakAt = line.length;
  }
  lines.push(line);
  const trimmed = lines.map(trimSpaces).filter((l) => l.length > 0);
  return trimmed.length > 0 ? trimmed : [[]];
}

function trimSpaces(line: Item[]): Item[] {
  let start = 0;
  let end = line.length;
  while (start < end && line[start]?.code === 0x20) start++;
  while (end > start && line[end - 1]?.code === 0x20) end--;
  return line.slice(start, end);
}

function anchorAlign(anchor: TextAnchor): { h: number; v: number } {
  const h = anchor.includes('left') ? 0 : anchor.includes('right') ? 1 : 0.5;
  const v = anchor.startsWith('top') ? 0 : anchor.startsWith('bottom') ? 1 : 0.5;
  return { h, v };
}

function justifyFactor(options: ShapingOptions): number {
  if (options.justify === 'auto') return anchorAlign(options.anchor).h;
  return options.justify === 'left' ? 0 : options.justify === 'right' ? 1 : 0.5;
}

/** Shapes `text` with the glyphs `lookup` finds. */
export function shapeText(text: string, lookup: GlyphLookup, options: ShapingOptions = DEFAULT_SHAPING): Shaping {
  const spacing = options.letterSpacingEm * ONE_EM_PX;
  const missing: number[] = [];
  const items: Item[] = [];
  for (const char of text.normalize('NFC')) {
    const code = char.codePointAt(0) ?? 0;
    const resolved = lookup(code);
    if (resolved === undefined && code !== 0x0a && code !== 0x20) {
      missing.push(code);
      continue;
    }
    const advance = code === 0x0a ? 0 : (resolved?.glyph.advance ?? ONE_EM_PX / 4) + spacing;
    items.push({ code, advance, resolved });
  }
  const lines = breakLines(items, options.maxWidthEm * ONE_EM_PX);
  const lineHeight = options.lineHeightEm * ONE_EM_PX;
  const widths = lines.map((line) => line.reduce((sum, i) => sum + i.advance, 0) - (line.length > 0 ? spacing : 0));
  const maxWidth = Math.max(0, ...widths);
  const justify = justifyFactor(options);
  const { h, v } = anchorAlign(options.anchor);
  const height = lines.length * lineHeight;
  const shiftX = -maxWidth * h + options.offsetEm[0] * ONE_EM_PX;
  const shiftY = -height * v + options.offsetEm[1] * ONE_EM_PX;
  const glyphs: PositionedGlyph[] = [];
  lines.forEach((line, index) => {
    let x = (maxWidth - (widths[index] ?? 0)) * justify;
    // Baseline at about 0.8 em below the line top, as glyph metrics place `top` relative to the baseline.
    const y = index * lineHeight + (lineHeight - ONE_EM_PX) / 2 + ONE_EM_PX * 0.8;
    for (const item of line) {
      if (item.resolved !== undefined && item.code !== 0x20) {
        const { glyph, fontStack } = item.resolved;
        glyphs.push({ code: item.code, x: x + shiftX, y: y + shiftY, line: index, fontStack, glyph });
      }
      x += item.advance;
    }
  });
  return {
    glyphs,
    lineCount: lines.length,
    left: shiftX,
    top: shiftY,
    right: shiftX + maxWidth,
    bottom: shiftY + height,
    missing,
  };
}
