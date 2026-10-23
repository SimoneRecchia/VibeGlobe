/**
 * Signed distance field glyphs drawn locally with the canvas 2D API (F448, ADR 0132), original code: the fallback for
 * characters the style's glyph server lacks (CJK with a configured font family), and the generator of the fixture
 * glyph ranges. The output matches the glyph PBF format at 24 px: one byte per texel with a 3-texel border, 0.75 at
 * the outline and 1/8 per texel (radius 8), metrics in pixels with `top` the height of the bitmap above the baseline.
 * Distances come from a two-pass exact Euclidean distance transform (Felzenszwalb and Huttenlocher) over the
 * anti-aliased coverage.
 */

/** One rasterized glyph. */
export interface LocalGlyph {
  readonly id: number;
  /** (width + 6) × (height + 6) bytes, or empty for a glyph without ink. */
  readonly bitmap: number[];
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly advance: number;
}

const SIZE = 24;
const BORDER = 3;
const RADIUS = 8;
const CUTOFF = 0.25;
const INF = 1e20;

/** One dimension of the squared distance transform: `f` sampled, `d` the lower envelope of parabolas. */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let r = v[k] ?? 0;
    let s = ((f[q] ?? 0) + q * q - ((f[r] ?? 0) + r * r)) / (2 * q - 2 * r);
    while (s <= (z[k] ?? 0) && k > 0) {
      k--;
      r = v[k] ?? 0;
      s = ((f[q] ?? 0) + q * q - ((f[r] ?? 0) + r * r)) / (2 * q - 2 * r);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while ((z[k + 1] ?? 0) < q) k++;
    const r = v[k] ?? 0;
    d[q] = (q - r) * (q - r) + (f[r] ?? 0);
  }
}

/** In place: squared distances to the nearest zero → distances, over a `w` × `h` grid. */
function edt(grid: Float64Array, w: number, h: number): void {
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x] ?? 0;
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y] ?? 0;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x] ?? 0;
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) grid[y * w + x] = Math.sqrt(d[x] ?? 0);
  }
}

/** The SDF bytes of anti-aliased coverage (alpha of RGBA pixels), `w` × `h`. */
export function sdfFromCoverage(rgba: ArrayLike<number>, w: number, h: number): number[] {
  const outer = new Float64Array(w * h);
  const inner = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = (rgba[i * 4 + 3] ?? 0) / 255;
    // Sub-texel edges from the anti-aliased coverage, as distances to the outline.
    outer[i] = a === 1 ? 0 : a === 0 ? INF : Math.max(0, 0.5 - a) ** 2;
    inner[i] = a === 1 ? INF : a === 0 ? 0 : Math.max(0, a - 0.5) ** 2;
  }
  edt(outer, w, h);
  edt(inner, w, h);
  const bitmap = new Array<number>(w * h);
  for (let i = 0; i < w * h; i++) {
    const d = (outer[i] ?? 0) - (inner[i] ?? 0);
    bitmap[i] = Math.max(0, Math.min(255, Math.round(255 - 255 * (d / RADIUS + CUTOFF))));
  }
  return bitmap;
}

/** A 2D context for drawing glyphs, or undefined where canvases are missing. */
function glyphContext(
  box: number,
  font: string,
): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | undefined {
  const canvas =
    typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(box, box)
      : typeof document === 'object'
        ? Object.assign(document.createElement('canvas'), { width: box, height: box })
        : undefined;
  const ctx = canvas?.getContext('2d', { willReadFrequently: true }) as
    CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null | undefined;
  if (ctx === undefined || ctx === null) return undefined;
  ctx.font = font;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = 'black';
  return ctx;
}

/** Rasterizes code points in a CSS font weight and family, at 24 px. */
export function rasterizeSdfGlyphs(fontWeight: string, fontFamily: string, codes: readonly number[]): LocalGlyph[] {
  const box = SIZE * 2 + BORDER * 4;
  const ctx = glyphContext(box, `${fontWeight} ${SIZE}px ${fontFamily}`);
  if (ctx === undefined) return [];
  return codes.map((code) => {
    const char = String.fromCodePoint(code);
    const m = ctx.measureText(char);
    const advance = Math.round(m.width);
    const left = Math.floor(-m.actualBoundingBoxLeft);
    const top = Math.ceil(m.actualBoundingBoxAscent);
    const width = Math.max(0, Math.ceil(m.actualBoundingBoxRight) - left);
    const height = Math.max(0, top + Math.ceil(m.actualBoundingBoxDescent));
    if (width === 0 || height === 0 || width + BORDER * 2 > box || height + BORDER * 2 > box)
      return { id: code, bitmap: [], width: 0, height: 0, left: 0, top: 0, advance };
    const w = width + BORDER * 2;
    const h = height + BORDER * 2;
    ctx.clearRect(0, 0, box, box);
    ctx.fillText(char, BORDER - left, BORDER + top);
    const bitmap = sdfFromCoverage(ctx.getImageData(0, 0, w, h).data, w, h);
    return { id: code, bitmap, width, height, left, top, advance };
  });
}
