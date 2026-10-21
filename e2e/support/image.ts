// Image measurements shared by the end-to-end tests.
import type { PNG } from 'pngjs';

/** Luminance of a pixel. */
function luminance(image: PNG, x: number, y: number): number {
  const i = (y * image.width + x) * 4;
  return 0.299 * (image.data[i] ?? 0) + 0.587 * (image.data[i + 1] ?? 0) + 0.114 * (image.data[i + 2] ?? 0);
}

/**
 * Estimates the sub-pixel translation from `before` to `after` over the central region (Lucas–Kanade least squares on
 * image gradients); valid for shifts well under a pixel.
 */
export function measureShift(before: PNG, after: PNG): { dx: number; dy: number } {
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let sxt = 0;
  let syt = 0;
  const x0 = Math.floor(before.width * 0.2);
  const y0 = Math.floor(before.height * 0.2);
  for (let y = y0; y < before.height - y0; y++) {
    for (let x = x0; x < before.width - x0; x++) {
      const ix = (luminance(before, x + 1, y) - luminance(before, x - 1, y)) / 2;
      const iy = (luminance(before, x, y + 1) - luminance(before, x, y - 1)) / 2;
      const it = luminance(after, x, y) - luminance(before, x, y);
      sxx += ix * ix;
      sxy += ix * iy;
      syy += iy * iy;
      sxt += ix * it;
      syt += iy * it;
    }
  }
  const det = sxx * syy - sxy * sxy;
  return { dx: (-syy * sxt + sxy * syt) / det, dy: (sxy * sxt - sxx * syt) / det };
}
