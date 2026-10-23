import type { ImagePart } from '../reproject/reprojected-imagery.js';
import type { SourceBbox } from '../reproject/warp-math.js';
import { STANDARD_PIXEL_M } from './crs.js';
import type { WmtsLimits, WmtsTileMatrix } from './wmts-capabilities.js';

/** The most tiles composed into one source image; a coarser matrix is used when a finer one would need more. */
const MAX_PARTS = 16;

function spanOf(matrix: WmtsTileMatrix): number {
  return matrix.scaleDenominator * STANDARD_PIXEL_M * matrix.tileWidth;
}

/** The area a matrix covers, in source units (projected systems, easting first): west, south, east, north. */
export function matrixBounds(matrix: WmtsTileMatrix): SourceBbox {
  const span = spanOf(matrix);
  const [x0, y0] = matrix.topLeftCorner;
  return [x0, y0 - matrix.matrixHeight * span, x0 + matrix.matrixWidth * span, y0];
}

/**
 * The tiles of a projected tile matrix set that compose a source image of `bbox` at `widthPx` × `heightPx` (F227):
 * the coarsest matrix at least as fine as the image, or a coarser one when that would take more than 16 tiles; each
 * tile placed in the image's pixels. Tiles outside the matrix or its limits are left out (transparent).
 */
export function wmtsParts(
  matrices: readonly WmtsTileMatrix[],
  limits: ReadonlyMap<string, WmtsLimits>,
  url: (matrix: string, row: number, col: number) => string,
  bbox: SourceBbox,
  widthPx: number,
  heightPx: number,
): ImagePart[] {
  const [w, s, e, n] = bbox;
  const wantedPx = (e - w) / widthPx;
  const sorted = [...matrices].sort((a, b) => b.scaleDenominator - a.scaleDenominator);
  const fits = sorted.filter((m) => {
    const span = spanOf(m);
    return Math.ceil((e - w) / span + 1) * Math.ceil((n - s) / span + 1) <= MAX_PARTS;
  });
  const matrix = fits.find((m) => m.scaleDenominator * STANDARD_PIXEL_M <= wantedPx) ?? fits.at(-1) ?? sorted[0];
  if (!matrix) return [];
  const span = spanOf(matrix);
  const [x0, y0] = matrix.topLeftCorner;
  const limit = limits.get(matrix.identifier);
  const minCol = Math.max(Math.floor((w - x0) / span), limit?.minCol ?? 0);
  const maxCol = Math.min(Math.ceil((e - x0) / span) - 1, limit?.maxCol ?? Infinity, matrix.matrixWidth - 1);
  const minRow = Math.max(Math.floor((y0 - n) / span), limit?.minRow ?? 0);
  const maxRow = Math.min(Math.ceil((y0 - s) / span) - 1, limit?.maxRow ?? Infinity, matrix.matrixHeight - 1);
  const scaleX = widthPx / (e - w);
  const scaleY = heightPx / (n - s);
  const parts: ImagePart[] = [];
  // Edges snapped to whole pixels, shared by neighbors: drawn at fractional positions, each part's antialiased edge
  // would leave a half-transparent line between them (F228).
  const xEdge = (c: number): number => Math.round((x0 + c * span - w) * scaleX);
  const yEdge = (r: number): number => Math.round((n - (y0 - r * span)) * scaleY);
  for (let row = minRow; row <= maxRow; row++)
    for (let col = minCol; col <= maxCol; col++)
      parts.push({
        url: url(matrix.identifier, row, col),
        xPx: xEdge(col),
        yPx: yEdge(row),
        widthPx: xEdge(col + 1) - xEdge(col),
        heightPx: yEdge(row + 1) - yEdge(row),
      });
  return parts;
}
