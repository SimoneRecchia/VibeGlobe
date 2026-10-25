// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
// The star catalog (ADR 0181) and how a star looks: its direction, magnitude and color, and the size and peak of its
// sprite at a pixel ratio, so a star keeps its brightness on every display and never shimmers when the sky moves.
import { STAR_CATALOG_BASE64 } from './star-catalog-data.js';

const DEG = Math.PI / 180;
const BYTES_PER_STAR = 6;
/** The temperature encoding of the catalog: logarithmic from 2,000 K to 50,000 K over 0–255. */
const LOG_KELVIN_MIN = Math.log(2000);
const LOG_KELVIN_MAX = Math.log(50_000);

/** The decoded catalog, brightest first. */
export interface StarCatalog {
  readonly count: number;
  /** Unit directions in J2000 equatorial axes, 3 per star. */
  readonly directions: Float32Array;
  /** Visual magnitudes. */
  readonly magnitudes: Float32Array;
  /** Linear RGB colors, each channel at most 1, 3 per star. */
  readonly colors: Float32Array;
}

/** Decodes base64 without the DOM (`atob` is not in every runtime's types for core-style code). */
function decodeBase64(text: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const values = new Uint8Array(128);
  for (let i = 0; i < alphabet.length; i++) values[alphabet.charCodeAt(i)] = i;
  const length = text.replace(/=+$/, '').length;
  const out = new Uint8Array(Math.floor((length * 3) / 4));
  let bits = 0;
  let count = 0;
  let o = 0;
  for (let i = 0; i < length; i++) {
    bits = (bits << 6) | (values[text.charCodeAt(i)] ?? 0);
    count += 6;
    if (count >= 8) {
      count -= 8;
      out[o++] = (bits >> count) & 0xff;
    }
  }
  return out;
}

/** Planck's law up to a constant, for a wavelength in nanometers and a temperature in kelvin. */
function planck(wavelengthNm: number, kelvin: number): number {
  const lambda = wavelengthNm * 1e-9;
  return 1 / (lambda ** 5 * (Math.exp(0.014388 / (lambda * kelvin)) - 1));
}

/**
 * The display color of a star of a temperature: black-body radiance at red, green and blue wavelengths, scaled so the
 * brightest channel is 1, then half-way toward white, since the eye sees stars only faintly colored.
 */
export function starColor(kelvin: number, out: Float32Array, offset = 0): void {
  const r = planck(610, kelvin);
  const g = planck(550, kelvin);
  const b = planck(465, kelvin);
  const max = Math.max(r, g, b);
  out[offset] = 0.5 + (0.5 * r) / max;
  out[offset + 1] = 0.5 + (0.5 * g) / max;
  out[offset + 2] = 0.5 + (0.5 * b) / max;
}

let decoded: StarCatalog | undefined;

/** The catalog, decoded once. */
export function decodeStarCatalog(): StarCatalog {
  if (decoded) return decoded;
  const bytes = decodeBase64(STAR_CATALOG_BASE64);
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = Math.floor(bytes.length / BYTES_PER_STAR);
  const directions = new Float32Array(count * 3);
  const magnitudes = new Float32Array(count);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const at = i * BYTES_PER_STAR;
    const ra = (data.getUint16(at, true) / 65_536) * 2 * Math.PI;
    const dec = (data.getInt16(at + 2, true) / 32_767) * 90 * DEG;
    directions[i * 3] = Math.cos(dec) * Math.cos(ra);
    directions[i * 3 + 1] = Math.cos(dec) * Math.sin(ra);
    directions[i * 3 + 2] = Math.sin(dec);
    magnitudes[i] = (bytes[at + 4] ?? 0) / 25 - 2;
    const kelvin = Math.exp(LOG_KELVIN_MIN + ((bytes[at + 5] ?? 0) / 255) * (LOG_KELVIN_MAX - LOG_KELVIN_MIN));
    starColor(kelvin, colors, i * 3);
  }
  decoded = { count, directions, magnitudes, colors };
  return decoded;
}

/** The smallest Gaussian radius of a sprite, device pixels: below it a moving star's pixel sum would flicker. */
export const MIN_SIGMA_DEVICE_PX = 0.75;
/** A star's light, in CSS pixels at peak 1, at magnitude 6.5 (the faintest the naked eye sees). */
const LIGHT_AT_6_5 = 0.25;

/** How a star is drawn at a pixel ratio: the Gaussian's radius in device pixels and its peak, 0–1. */
export interface StarSprite {
  readonly sigmaDevicePx: number;
  readonly peak: number;
}

/**
 * The sprite of a star of a magnitude at a pixel ratio. Its light in CSS pixels (the integral of the Gaussian) is the
 * same at every pixel ratio until the peak saturates, so a star looks equally bright on every display; the radius never
 * falls under {@link MIN_SIGMA_DEVICE_PX}, so the pixels' sum stays constant to 10⁻⁴ as the star moves by a fraction of
 * a pixel (no shimmering). The light follows the magnitude with a compressed slope (0.6 of Pogson's), as photographs of
 * the sky do, so a display's range shows both the brightest and the faintest stars.
 */
export function starSprite(magnitude: number, pixelRatio: number, brightness = 1): StarSprite {
  const sigmaCssPx = 0.5 + 0.12 * Math.max(0, 3 - magnitude);
  const sigmaDevicePx = Math.max(MIN_SIGMA_DEVICE_PX, sigmaCssPx * pixelRatio);
  const light = brightness * LIGHT_AT_6_5 * 10 ** (-0.24 * (magnitude - 6.5));
  // Peak × 2πσ² (in CSS pixels) = light.
  const sigmaCss = sigmaDevicePx / pixelRatio;
  return { sigmaDevicePx, peak: Math.min(1, light / (2 * Math.PI * sigmaCss * sigmaCss)) };
}
