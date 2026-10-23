// Labels stay still and fade (M10, F360): scripted pan, zoom, rotate and tilt paths over 10,000 labels, frame by frame
// on the manual engine clock. Every frame is recorded: no label reverses its fade twice within the fade window, every
// visibility change is a fade at the documented rate (300 ms from hidden to shown), and the drawn text of tracked
// labels moves with its anchor, never jumping more than 1 pixel beyond the camera's motion.
import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage, nextFrame, openGlobe, waitForIdle } from './support/globe.ts';

test.use({ viewport: { width: 480, height: 360 } });

const BACKENDS = ['webgpu', 'webgl2'] as const;
const FRAME_MS = 1000 / 60;
/** The documented fade (`PlacementOptions.fadeDurationMs`, docs/guides/data-layers.md). */
const FADE_MS = 300;
const STEPS = 40;

interface View {
  longitudeDeg: number;
  latitudeDeg: number;
  zoom: number;
  headingDeg: number;
  tiltDeg: number;
}

const START: View = { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 9, headingDeg: 0, tiltDeg: 0 };
/** Each path: the view at step `k` of `STEPS`. */
const PATHS: Record<string, (k: number) => View> = {
  pan: (k) => ({ ...START, longitudeDeg: 12.5 + k * 0.004, latitudeDeg: 41.9 - k * 0.002 }),
  zoom: (k) => ({ ...START, zoom: 9 + k * 0.0125 }),
  rotate: (k) => ({ ...START, headingDeg: k * 0.75 }),
  tilt: (k) => ({ ...START, tiltDeg: k * 0.75 }),
};

interface Frame {
  /** The engine clock at the frame. */
  timeMs: number;
  opacities: number[];
  anchors: ({ xPx: number; yPx: number } | undefined)[];
}

/** Applies a view, draws one engine frame, and records every label's opacity and the tracked labels' anchors. */
async function step(page: Page, view: View, tracked: string[]): Promise<Frame> {
  return page.evaluate(
    async ({ view, tracked }) => {
      const globe = window.vibeglobePlayground?.globe;
      if (!globe) throw new Error('no globe');
      globe.jumpTo(view);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const placer = (window.vibeglobeLayers?.layers['dense'] as unknown as { placer: { opacity(id: string): number } })
        .placer;
      const opacities: number[] = [];
      for (let i = 0; i < 10_000; i++) opacities.push(placer.opacity(`r${String((i * 7919) % 5)}-${String(i)}`));
      const anchors = tracked.map((id) => {
        const i = Number(id.slice(id.indexOf('-') + 1));
        return globe.geoToScreen({
          longitudeDeg: 11.5 + (i % 100) * 0.02,
          latitudeDeg: 40.9 + Math.floor(i / 100) * 0.02,
        });
      });
      return { timeMs: globe.timeMs, opacities, anchors };
    },
    { view, tracked },
  );
}

/**
 * Centroid of the red (priority 0) text within a box around a point, each pixel weighted by how red it is (so the
 * antialiased edges count in proportion and sub-pixel motion moves it smoothly), or undefined when there is too little.
 */
function centroid(image: PNG, at: { xPx: number; yPx: number }, halfW: number, halfH: number) {
  let sx = 0;
  let sy = 0;
  let sw = 0;
  for (let y = Math.max(0, Math.floor(at.yPx - halfH)); y <= Math.min(image.height - 1, at.yPx + halfH); y++)
    for (let x = Math.max(0, Math.floor(at.xPx - halfW)); x <= Math.min(image.width - 1, at.xPx + halfW); x++) {
      const i = (y * image.width + x) * 4;
      const [r, g, b] = [image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0];
      // Red text over the yellow-green ground; orange (priority 1) text has a far larger green than blue.
      const w = Math.abs(g - b) < 60 ? Math.max(0, r - g) : 0;
      sx += w * x;
      sy += w * y;
      sw += w;
    }
  return sw < 12 * 60 ? undefined : { xPx: sx / sw, yPx: sy / sw };
}

for (const backend of BACKENDS) {
  test(`labels do not flicker, jitter or pop while panning, zooming, rotating and tilting, and fade in and out, on ${backend} (F360)`, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await openGlobe(
      page,
      `clockStepMs=${String(FRAME_MS)}&backend=${backend}&scenario=data-labels-dense&viewMode=3d&lon=12.5&lat=41.9&zoom=9`,
    );
    await page.waitForFunction(() => window.vibeglobeLayers !== undefined);
    await page.evaluate(() =>
      document.querySelector<HTMLElement>('#camera-controls')?.style.setProperty('display', 'none'),
    );
    // Settled at the start view: placement caught up and the fades ended.
    for (let i = 0; i < 400; i++) {
      await nextFrame(page);
      const pending = await page.evaluate(
        () => (window.vibeglobeLayers?.layers['dense'] as unknown as { placer: { pending: boolean } }).placer.pending,
      );
      if (!pending && i > 30) break;
    }
    await waitForIdle(page);
    // Tracked: the priority-0 labels on screen, shown or not (pans move the screen edge, which changes the greedy
    // placement), with the half-size of their text; compared in the frames where they are fully shown.
    const boxes = await page.evaluate(() =>
      (
        window.vibeglobeLayers?.layers['dense'] as unknown as {
          collisionBoxes: { id: string; minX: number; minY: number; maxX: number; maxY: number; placed: boolean }[];
        }
      ).collisionBoxes
        .filter((b) => String(b.id).startsWith('r0-'))
        .map((b) => ({ ...b, id: String(b.id) })),
    );
    const central = boxes
      .filter((b) => Math.abs((b.minX + b.maxX) / 2 - 240) < 190 && Math.abs((b.minY + b.maxY) / 2 - 180) < 140)
      .slice(0, 120);
    expect(central.length, 'tracked labels').toBeGreaterThanOrEqual(20);
    const tracked = central.map((b) => b.id);
    const half = central.map((b) => ({ w: (b.maxX - b.minX) / 2, h: (b.maxY - b.minY) / 2 }));
    for (const [name, path] of Object.entries(PATHS)) {
      const frames: Frame[] = [];
      const images: PNG[] = [];
      for (let k = 0; k <= STEPS; k++) {
        frames.push(await step(page, path(k), tracked));
        images.push(await canvasImage(page));
      }
      // Fades, not pops, and no reversal within the fade window.
      const pops: string[] = [];
      const flickers: string[] = [];
      for (let label = 0; label < 10_000; label++) {
        let lastDirection = 0;
        let lastReversal = -Infinity;
        for (let k = 1; k < frames.length; k++) {
          const d = (frames[k]?.opacities[label] ?? 0) - (frames[k - 1]?.opacities[label] ?? 0);
          const elapsedMs = (frames[k]?.timeMs ?? 0) - (frames[k - 1]?.timeMs ?? 0);
          if (Math.abs(d) > elapsedMs / FADE_MS + 1e-6) pops.push(`${String(label)}@${String(k)}: ${d.toFixed(3)}`);
          const direction = Math.sign(d);
          if (direction !== 0 && lastDirection !== 0 && direction !== lastDirection) {
            const nowMs = frames[k]?.timeMs ?? 0;
            if (nowMs - lastReversal < FADE_MS) flickers.push(`${String(label)}@${String(k)}`);
            lastReversal = nowMs;
          }
          if (direction !== 0) lastDirection = direction;
        }
      }
      expect(pops, `${name}: visibility changes faster than the fade`).toEqual([]);
      expect(flickers, `${name}: fades reversed twice within the fade window`).toEqual([]);
      // The tracked labels' text moves with its anchor.
      const jumps: string[] = [];
      let compared = 0;
      for (const [t, id] of tracked.entries()) {
        const size = half[t] ?? { w: 20, h: 8 };
        for (let k = 1; k < frames.length; k++) {
          const label = Number(id.slice(id.indexOf('-') + 1));
          if ((frames[k]?.opacities[label] ?? 0) < 1 || (frames[k - 1]?.opacities[label] ?? 0) < 1) continue;
          const a0 = frames[k - 1]?.anchors[t];
          const a1 = frames[k]?.anchors[t];
          // Only labels whose text is wholly on screen: the edge clips text and moves its centroid.
          const inside = (a: { xPx: number; yPx: number }) =>
            a.xPx - size.w >= 0 && a.yPx - size.h >= 0 && a.xPx + size.w < 480 && a.yPx + size.h < 360;
          if (!a0 || !a1 || !inside(a0) || !inside(a1)) continue;
          const c0 = centroid(images[k - 1] as PNG, a0, size.w, size.h);
          const c1 = centroid(images[k] as PNG, a1, size.w, size.h);
          if (!c0 || !c1) continue;
          compared++;
          const offX = c1.xPx - a1.xPx - (c0.xPx - a0.xPx);
          const offY = c1.yPx - a1.yPx - (c0.yPx - a0.yPx);
          if (Math.hypot(offX, offY) > 1) jumps.push(`${id}@${String(k)}: ${offX.toFixed(2)}, ${offY.toFixed(2)}`);
        }
      }
      expect(compared, `${name}: frame pairs compared`).toBeGreaterThan(STEPS);
      expect(jumps, `${name}: text moving more than 1 px beyond its anchor`).toEqual([]);
    }
  });
}
