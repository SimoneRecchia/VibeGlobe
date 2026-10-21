/** Terrarium height encoding: `height = R·256 + G + B/256 − 32768` meters, a step of 1/256 m (ADR 0023). */
import { encodePng } from './png.js';

/** Quantization step of Terrarium heights, in meters. */
export const TERRARIUM_STEP_M = 1 / 256;

/** Encodes heights in meters (one per pixel) as Terrarium RGB pixels, rounding to the nearest step. */
function terrariumPixels(heights: Float32Array): Uint8Array {
  const out = new Uint8Array(heights.length * 3);
  for (let i = 0; i < heights.length; i++) {
    const clamped = Math.max(-32768, Math.min(32767.99609375, heights[i] ?? 0));
    const v = Math.round((clamped + 32768) * 256);
    out[i * 3] = v >> 16;
    out[i * 3 + 1] = (v >> 8) & 0xff;
    out[i * 3 + 2] = v & 0xff;
  }
  return out;
}

/** Decodes the height of one Terrarium pixel. */
export function terrariumHeight(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/** Encodes a square tile of heights as a Terrarium PNG. */
export function encodeTerrariumTile(heights: Float32Array, size: number): Uint8Array {
  return encodePng(terrariumPixels(heights), size, size, 3);
}
