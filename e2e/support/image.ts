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

/**
 * Estimates the translation from `before` to `after`, also beyond a pixel: the integer shift within ±`searchPx` with the
 * smallest mean luminance difference over the central region, refined by {@link measureShift}.
 */
export function measureLargeShift(before: PNG, after: PNG, searchPx: number): { dx: number; dy: number } {
  const x0 = Math.floor(before.width * 0.2);
  const y0 = Math.floor(before.height * 0.2);
  let best = { sx: 0, sy: 0, cost: Infinity };
  for (let sy = -searchPx; sy <= searchPx; sy++) {
    for (let sx = -searchPx; sx <= searchPx; sx++) {
      let cost = 0;
      for (let y = y0; y < before.height - y0; y++) {
        for (let x = x0; x < before.width - x0; x++)
          cost += Math.abs(luminance(after, x + sx, y + sy) - luminance(before, x, y));
      }
      if (cost < best.cost) best = { sx, sy, cost };
    }
  }
  const shifted = { width: before.width, height: before.height, data: Buffer.alloc(before.data.length) } as PNG;
  for (let y = 0; y < before.height; y++) {
    for (let x = 0; x < before.width; x++) {
      const from =
        (Math.min(Math.max(y + best.sy, 0), after.height - 1) * after.width +
          Math.min(Math.max(x + best.sx, 0), after.width - 1)) *
        4;
      after.data.copy(shifted.data, (y * before.width + x) * 4, from, from + 4);
    }
  }
  const residual = measureShift(before, shifted);
  return { dx: best.sx + residual.dx, dy: best.sy + residual.dy };
}
