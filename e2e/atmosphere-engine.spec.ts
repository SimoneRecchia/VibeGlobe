// The atmosphere drawn by the engine (M11, ADR 0040), through the playground's `?atmosphere=` and `?fog=0` switches:
// the sky above a tilted view's horizon (F391). The look of the sky, glow, haze and sun lighting is measured on the
// atmosphere harness (e2e/atmosphere.spec.ts).
import { expect, test } from '@playwright/test';
import { canvasImage, openGlobe } from './support/globe.ts';
import { waitForStreaming } from './support/imagery.ts';

test.use({ viewport: { width: 320, height: 240 } });

/** A view at the maximum tilt over the Alps, the horizon in the upper part of the frame. */
const TILTED = 'imagery=world&lon=8&lat=46&zoom=9&tilt=80';

for (const backend of ['webgpu', 'webgl2'] as const)
  test(`F391: the engine draws a sky above the horizon of a tilted view, not the background, on ${backend}`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const top = async (query: string): Promise<[number, number, number]> => {
      await openGlobe(page, `backend=${backend}&${TILTED}${query}`);
      await waitForStreaming(page);
      const image = await canvasImage(page);
      const sum = [0, 0, 0];
      // The top tenth of the frame: above the horizon at this tilt.
      const rows = Math.floor(image.height / 10);
      for (let y = 0; y < rows; y++)
        for (let x = 0; x < image.width; x++)
          for (let c = 0; c < 3; c++) sum[c] = (sum[c] ?? 0) + (image.data[(y * image.width + x) * 4 + c] ?? 0);
      return sum.map((v) => v / (rows * image.width)) as [number, number, number];
    };
    const without = await top('');
    const sky = await top('&atmosphere=high');
    console.log(`[atmosphere] F391 ${backend}: top without ${without.map(Math.round)}, with ${sky.map(Math.round)}`);
    // Without the atmosphere the top is the clear color; with it, a sky: bright and bluer than red.
    const [r, g, b] = sky;
    expect(r + g + b).toBeGreaterThan(without.reduce((s, v) => s + v, 0) + 60);
    expect(b).toBeGreaterThan(r);
  });
