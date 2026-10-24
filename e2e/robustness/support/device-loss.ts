// The device-loss scenario of F512, shared by its default spec and its known-bug spec: 50 GPU device losses (WebGPU)
// or WebGL context losses per backend at random moments of flights, eases, jumps (tile uploads) and view-mode
// changes, each recovered without a page reload. The same view, drawn before and after the recoveries, shows the same
// layers, and no renderer object, device or context is kept per loss.
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage, expectCompleteGlobe, openGlobe, waitForIdle } from '../../support/globe.ts';
import { heapObjects, trackGpuObjects } from '../../support/leaks.ts';
import { collectErrors, runSeed, scaled, unexpected } from './probes.ts';

const BACKENDS = ['webgpu', 'webgl2'] as const;
/** Rome: the view compared before and after the losses. */
const HOME = { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 9, headingDeg: 0, tiltDeg: 0 };
/** A recovered frame may differ by anti-aliasing and the cross-fade's last steps, never by a missing layer. */
const CHANGED_CHANNEL = 24;
const CHANGED_FRACTION = 0.01;

/** The share of pixels whose color differs by more than `CHANGED_CHANNEL` in a channel. */
function changedFraction(a: PNG, b: PNG): number {
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      if (Math.abs((a.data[i + c] ?? 0) - (b.data[i + c] ?? 0)) > CHANGED_CHANNEL) {
        changed++;
        break;
      }
    }
  }
  return changed / (a.width * a.height);
}

/** Jumps home and waits until every tile of the view has arrived and the engine stopped drawing. */
async function settleHome(page: Page): Promise<void> {
  await page.evaluate((view) => window.vibeglobePlayground?.globe.jumpTo(view), HOME);
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const stats = window.vibeglobePlayground?.globe.imageryStats();
          return stats ? stats.queued + stats.loading + stats.decoding + stats.uploadsPending : 0;
        }),
      { timeout: 60_000 },
    )
    .toBe(0);
  await waitForIdle(page);
}

/**
 * Objects one renderer owns: a recovery that kept its lost renderer, backend, device, context or canvas leaks one of
 * them per loss. The tile caches' contents are not counted: navigation fills them within their budgets.
 */
const PER_RENDERER = [
  'WebGPURenderer',
  'WebGPUBackend',
  'WebGLBackend',
  'GPUDevice',
  'WebGL2RenderingContext',
  'GPUCanvasContext',
  'HTMLCanvasElement',
];

/** The page's live contexts, the engine's GPU bytes, and the live instances of `PER_RENDERER` after a collection. */
async function resources(page: Page, cdp: CDPSession) {
  await page.waitForTimeout(500);
  await cdp.send('HeapProfiler.collectGarbage');
  const live = await page.evaluate(() => ({
    contexts: (window as unknown as { liveContexts: () => number }).liveContexts(),
    gpuBytes: window.vibeglobePlayground?.globe.resourceCounts().gpuBytes ?? 0,
  }));
  const { instances } = await heapObjects(cdp);
  return { ...live, renderers: Object.fromEntries(PER_RENDERER.map((name) => [name, instances.get(name) ?? 0])) };
}

/**
 * The engine recovers at most 3 losses within 60 s and gives up on the fourth (ADR 0010 §8): losses are spaced so no
 * window of this length holds more than 3, with navigation going on in between.
 */
const RECOVERY_WINDOW_MS = 61_000;

/**
 * Plays random movements (flights, eases, jumps that start tile uploads, view-mode changes) until `losses` losses were
 * forced, each at a random moment 0–1500 ms into a movement whenever the recovery limit allows one, and waits for each
 * recovery and for every movement to settle. Returns the recoveries counted and the movements' outcomes.
 */
async function loseDuringNavigation(page: Page, losses: number, seed: number) {
  return page.evaluate(
    async ({ losses, seed, windowMs }) => {
      const globe = window.vibeglobePlayground?.globe;
      if (!globe) throw new Error('no globe');
      let state = seed >>> 0;
      const random = (): number => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      let restored = 0;
      globe.on('device-restored', () => restored++);
      const place = () => ({
        longitudeDeg: -180 + random() * 360,
        latitudeDeg: -70 + random() * 140,
        zoom: 2 + random() * 8,
        headingDeg: random() * 360,
        tiltDeg: random() * 50,
      });
      const outcomes: Record<string, number> = {};
      const lossKinds: Record<string, number> = {};
      const lossTimesMs: number[] = [];
      let movements = 0;
      while (lossTimesMs.length < losses) {
        const kind = ['fly', 'ease', 'jump', 'mode'][Math.floor(random() * 4)] ?? 'fly';
        let movement: Promise<string> | undefined;
        if (kind === 'fly') movement = globe.flyTo(place(), { durationMs: 1500 });
        else if (kind === 'ease') movement = globe.easeTo(place(), { durationMs: 800 });
        else if (kind === 'jump') movement = globe.jumpTo(place());
        else globe.setViewMode((['2d', '3d', 'auto'] as const)[Math.floor(random() * 3)] ?? 'auto');
        await new Promise((resolve) => setTimeout(resolve, random() * 1500));
        const now = performance.now();
        const recent = lossTimesMs.filter((time) => now - time < windowMs).length;
        if (recent < 3) {
          lossKinds[kind] = (lossKinds[kind] ?? 0) + 1;
          lossTimesMs.push(now);
          const before = restored;
          globe.simulateDeviceLoss();
          const deadline = performance.now() + 30_000;
          while (restored === before && performance.now() < deadline) await new Promise((r) => setTimeout(r, 20));
          if (restored === before) throw new Error(`loss ${lossTimesMs.length} (${kind}) not recovered within 30 s`);
        }
        if (movement) {
          movements++;
          const outcome = await movement;
          outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
        }
      }
      globe.setViewMode('auto');
      return { restored, movements, outcomes, lossKinds };
    },
    { losses, seed, windowMs: RECOVERY_WINDOW_MS },
  );
}

/**
 * Registers the scenario on both backends for a playground page with `query` (its layers): `scene` names them in the
 * test titles.
 */
export function deviceLossTests(scene: string, query: string): void {
  test.use({ viewport: { width: 320, height: 240 } });
  for (const backend of BACKENDS) {
    test(`50 ${backend === 'webgpu' ? 'device' : 'context'} losses at random moments of navigation recover ${scene} without a reload or a leak on ${backend} (F512)`, async ({
      page,
    }) => {
      const losses = scaled(50);
      const seed = runSeed();
      console.log(`[robustness] F512 ${backend} seed ${seed} losses ${losses}`);
      // 50 losses at 3 a minute: about 17 minutes of navigation.
      test.setTimeout(2_400_000);
      const errors = await collectErrors(page);
      await page.addInitScript(trackGpuObjects);
      await openGlobe(page, `backend=${backend}&${query}&lon=12.5&lat=41.9&zoom=9`);
      const navigations = await page.evaluate(() => performance.getEntriesByType('navigation').length);
      const cdp = await page.context().newCDPSession(page);
      await settleHome(page);
      const before = { image: await canvasImage(page), ...(await resources(page, cdp)) };

      const report = await loseDuringNavigation(page, losses, seed);
      console.log(`[robustness] F512 ${backend}: ${JSON.stringify(report)}`);
      expect(report.restored).toBe(losses);
      // Every movement settled: a loss neither rejects a flight nor leaves it hanging.
      expect(Object.values(report.outcomes).reduce((a, b) => a + b, 0)).toBe(report.movements);

      await settleHome(page);
      const after = { image: await canvasImage(page), ...(await resources(page, cdp)) };
      console.log(
        `[robustness] F512 ${backend} resources before ${JSON.stringify({ ...before, image: undefined })} after ${JSON.stringify({ ...after, image: undefined })}`,
      );
      // No reload: the same document, the same backend, and still the same globe instance answering.
      expect(await page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(navigations);
      expect(await page.evaluate(() => window.vibeglobePlayground?.globe.backend)).toBe(backend);
      await expectCompleteGlobe(page);
      // Every layer restored: the imagery and the data layers draw the same view as before.
      expect(changedFraction(before.image, after.image)).toBeLessThan(CHANGED_FRACTION);
      // No leak: one device or context, no renderer object kept per loss (three.js's module-level output node may keep
      // the last lost renderer, KB-045), and GPU memory within the default 512 MiB budget.
      expect(after.contexts).toBe(1);
      for (const name of PER_RENDERER)
        expect(after.renderers[name], name).toBeLessThanOrEqual((before.renderers[name] ?? 0) + 1);
      expect(after.gpuBytes).toBeLessThanOrEqual(512 * 1024 * 1024);
      expect(unexpected(errors)).toEqual([]);
    });
  }
}
