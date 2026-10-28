// F379's budget step: hover picks on a 100,000-point layer fit in a frame. The first pick after the view changes
// projects the layer once into a screen grid; the picks that follow, while the view stays, read only the grid cells
// around the pointer.
import { expect, test } from '@playwright/test';
import { openGlobe, waitForIdle } from './support/globe.ts';

test.use({ viewport: { width: 480, height: 360 } });

for (const backend of ['webgpu', 'webgl2'] as const)
  test(`hover picks on a 100,000-point layer stay within the per-frame budget on ${backend} (F379)`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await openGlobe(page, `backend=${backend}&scenario=data-stream&lon=11.5&lat=41.5&zoom=7`);
    await page.waitForFunction(() => window.vibeglobeStream !== undefined);
    await page.evaluate(() => {
      for (let chunk = 0; chunk < 100; chunk++) window.vibeglobeStream?.add(chunk);
    });
    expect(await page.evaluate(() => window.vibeglobeStream?.count())).toBe(100_000);
    await waitForIdle(page);
    const timing = await page.evaluate(async () => {
      const target = window.vibeglobePlayground?.globe.layerTarget();
      if (!target?.pick) throw new Error('no picking');
      const times: number[] = [];
      let hits = 0;
      // A pointer path across the view, one pick per step as a hover does.
      for (let i = 0; i < 200; i++) {
        const point = { xPx: 40 + ((i * 37) % 400), yPx: 40 + ((i * 53) % 280) };
        const start = performance.now();
        if ((await target.pick(point)) !== 0) hits++;
        times.push(performance.now() - start);
      }
      return { first: times[0] ?? 0, rest: times.slice(1).sort((a, b) => a - b), hits };
    });
    const median = timing.rest[Math.floor(timing.rest.length / 2)] ?? 0;
    const p95 = timing.rest[Math.floor(timing.rest.length * 0.95)] ?? 0;
    console.log(
      `[hover] ${backend}: first pick ${timing.first.toFixed(1)} ms, then median ${median.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms; ${timing.hits} of 200 on a point`,
    );
    // The pointer finds points (the layer covers most of the view) and a pick costs a small part of a 16.7 ms frame.
    expect(timing.hits).toBeGreaterThan(20);
    expect(median).toBeLessThan(2);
    expect(p95).toBeLessThan(4);
  });
