// F712: two images of the whole Earth ship with the package, as defaults an application may replace (ADR 0194).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { MercatorImageOptions } from './mercator-image.js';

const made: MercatorImageOptions[] = [];
vi.mock('./mercator-image.js', () => ({
  mercatorImage: (options: MercatorImageOptions) => (made.push(options), { id: options.id }),
}));

const { dayImageUrl, NIGHT_LIGHTS_ID, nightImageUrl, nightLights } = await import('./earth-images.js');

describe('the shipped images of the Earth (F712)', () => {
  it('resolves the day and night images to WebP files next to the module', () => {
    for (const url of [dayImageUrl(), nightImageUrl()]) {
      const bytes = readFileSync(fileURLToPath(url));
      expect(bytes.toString('latin1', 0, 4) + bytes.toString('latin1', 8, 12)).toBe('RIFFWEBP');
    }
  });

  it('lights the night side with the shipped image, or with the one given', () => {
    expect(nightLights()).toMatchObject({ id: NIGHT_LIGHTS_ID, blend: 'night', harmonize: false });
    nightLights('/lights.webp');
    expect(made.map((options) => options.image)).toEqual([nightImageUrl(), '/lights.webp']);
    expect(made[0]).toMatchObject({ id: NIGHT_LIGHTS_ID, maxLevel: 3 });
  });
});
