// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { describe, expect, it } from 'vitest';
import { MIN_SIGMA_DEVICE_PX, decodeStarCatalog, starColor, starSprite } from './star-catalog.js';

const DEG = Math.PI / 180;

describe('star catalog (F601)', () => {
  it('decodes the Yale Bright Star Catalog brightest first, Sirius at its J2000 position', () => {
    const catalog = decodeStarCatalog();
    expect(catalog.count).toBe(9096);
    expect(catalog.magnitudes[0]).toBeCloseTo(-1.46, 1);
    const [x, y, z] = catalog.directions;
    // Sirius: 06h 45m 08.9s, −16° 42′ 58″.
    expect((Math.atan2(y ?? 0, x ?? 0) / DEG + 360) % 360).toBeCloseTo(101.287, 2);
    expect(Math.asin(z ?? 0) / DEG).toBeCloseTo(-16.716, 2);
    for (let i = 1; i < catalog.count; i++)
      expect(catalog.magnitudes[i]).toBeGreaterThanOrEqual(catalog.magnitudes[i - 1] ?? 0);
  });

  it('colors hot stars blue-white and cool stars orange', () => {
    const hot = new Float32Array(3);
    const cool = new Float32Array(3);
    starColor(25_000, hot);
    starColor(3_200, cool);
    expect(hot[2]).toBeGreaterThan(hot[0] ?? 0);
    expect(cool[0]).toBeGreaterThan(cool[2] ?? 0);
    for (const channel of [...hot, ...cool]) expect(channel).toBeLessThanOrEqual(1);
  });
});

describe('star sprites (F604)', () => {
  it('keeps an unsaturated star equally bright at every pixel ratio and never under the minimum radius', () => {
    for (const magnitude of [3.5, 5, 6.5]) {
      const light = [1, 1.5, 2, 3].map((ratio) => {
        const { sigmaDevicePx, peak } = starSprite(magnitude, ratio);
        expect(sigmaDevicePx).toBeGreaterThanOrEqual(MIN_SIGMA_DEVICE_PX);
        return peak * 2 * Math.PI * (sigmaDevicePx / ratio) ** 2;
      });
      for (const value of light) expect(value / (light[0] ?? 1)).toBeCloseTo(1, 6);
    }
  });

  it('keeps the pixel sum of a moving faint star constant to 10⁻³ (no shimmering)', () => {
    const { sigmaDevicePx, peak } = starSprite(6, 1);
    const sums: number[] = [];
    for (let offset = 0; offset <= 1; offset += 0.125) {
      let sum = 0;
      for (let y = -4; y <= 4; y++)
        for (let x = -4; x <= 4; x++) {
          const dx = x + 0.5 - offset;
          const dy = y + 0.5 - offset * 0.37;
          sum += peak * Math.exp(-(dx * dx + dy * dy) / (2 * sigmaDevicePx * sigmaDevicePx));
        }
      sums.push(sum);
    }
    const mean = sums.reduce((a, b) => a + b, 0) / sums.length;
    for (const sum of sums) expect(Math.abs(sum / mean - 1)).toBeLessThan(1e-3);
  });

  it('orders brightness by magnitude and scales it with the brightness option', () => {
    expect(starSprite(1, 1).peak).toBeGreaterThan(starSprite(3, 1).peak);
    expect(starSprite(3, 1).peak).toBeGreaterThan(starSprite(6, 1).peak);
    expect(starSprite(6, 1, 2).peak).toBeCloseTo(2 * starSprite(6, 1).peak, 9);
  });
});
