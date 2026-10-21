// F065 / ADR 0011: measures rendering on the main thread against rendering from a worker with OffscreenCanvas, on both
// backends, with the playground's `?experiment=offscreen` mode: frame intervals during continuous drag with and without
// synthetic main-thread load (a 30 ms task every 100 ms), input-to-frame latency, and how far a DOM overlay drifts from
// the scene marker it frames (from screenshots taken during the drag). Needs `npm run build`.
// Results go to benchmarks/results/<device>/offscreen-<date>.json (device from VIBEGLOBE_DEVICE, default "local").
// Options: --browser chromium|firefox|webkit (Playwright engines), --channel chrome|msedge (installed Chrome or Edge),
// --hardware (use the machine's GPU instead of the software GPU of GPU-less CI; docs/guides/hardware-testing.md).
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
import { join } from 'node:path';
import { chromium, firefox, webkit, type Browser, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { preview } from 'vite';
import { SOFTWARE_GPU_ARGS } from '../scripts/browser/software-gpu.ts';
import { ROOT_DIR } from '../scripts/workspace.ts';

const BACKENDS = ['webgpu', 'webgl2'] as const;
const MODES = ['main', 'worker'] as const;
const VIEWPORT = { width: 480, height: 360 };
const WARM_UP_MS = 5000;
const DRIVE_MS = 10_000;
const SCREENSHOTS = 15;
const DRAG_RADIUS_PX = 40;

interface Experiment {
  readonly ready: Promise<string | undefined>;
  readonly frames: { timeMs: number; seq: number }[];
  readonly inputs: { seq: number; timeMs: number }[];
  setLoad(on: boolean): void;
  reset(): void;
}

type Hooked = Window & { vibeglobeRenderExperiment?: Experiment };

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

async function openExperiment(browser: Browser, baseUrl: string, mode: string, backend: string): Promise<Page> {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(
    new URL(`?experiment=offscreen&render=${mode}&backend=${backend}&lon=10&lat=45&zoom=3`, baseUrl).href,
  );
  await page.waitForFunction(() => (window as Hooked).vibeglobeRenderExperiment !== undefined);
  const active = await page.evaluate(() => (window as Hooked).vibeglobeRenderExperiment?.ready);
  if (active !== backend) throw new Error(`${mode}/${backend}: the globe started on ${String(active)}`);
  await page.waitForTimeout(WARM_UP_MS);
  if (errors.length > 0) throw new Error(`${mode}/${backend}: ${errors.join('; ')}`);
  return page;
}

/** Drags in circles around the canvas center with real input events until `untilMs` (performance.now of Node). */
async function drag(page: Page, untilMs: number): Promise<void> {
  const cx = VIEWPORT.width / 2;
  const cy = VIEWPORT.height / 2;
  await page.mouse.move(cx + DRAG_RADIUS_PX, cy);
  await page.mouse.down();
  for (let angle = 0; performance.now() < untilMs; angle += 0.05) {
    await page.mouse.move(cx + DRAG_RADIUS_PX * Math.cos(angle), cy + DRAG_RADIUS_PX * Math.sin(angle));
  }
  await page.mouse.up();
}

async function measureTiming(browser: Browser, baseUrl: string, mode: string, backend: string, load: boolean) {
  const page = await openExperiment(browser, baseUrl, mode, backend);
  try {
    await page.evaluate((on) => {
      const experiment = (window as Hooked).vibeglobeRenderExperiment;
      experiment?.setLoad(on);
      experiment?.reset();
    }, load);
    await drag(page, performance.now() + DRIVE_MS);
    const { frames, inputs } = await page.evaluate(() => {
      const experiment = (window as Hooked).vibeglobeRenderExperiment;
      experiment?.setLoad(false);
      return { frames: experiment?.frames ?? [], inputs: experiment?.inputs ?? [] };
    });
    const intervals = frames.slice(1).map((frame, index) => frame.timeMs - (frames[index]?.timeMs ?? 0));
    const latencies: number[] = [];
    let next = 0;
    for (const input of inputs) {
      while (next < frames.length && (frames[next]?.seq ?? 0) < input.seq) next++;
      const frame = frames[next];
      if (frame) latencies.push(frame.timeMs - input.timeMs);
    }
    return {
      frames: frames.length,
      frameIntervalP50Ms: round(percentile(intervals, 50)),
      frameIntervalP95Ms: round(percentile(intervals, 95)),
      inputs: inputs.length,
      inputLatencyP50Ms: round(percentile(latencies, 50)),
      inputLatencyP95Ms: round(percentile(latencies, 95)),
    };
  } finally {
    await page.close();
  }
}

/** Centroid of the pixels matching a color test, or undefined when there are too few. */
function centroid(image: PNG, match: (r: number, g: number, b: number) => boolean): [number, number] | undefined {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      if (match(image.data[i] ?? 0, image.data[i + 1] ?? 0, image.data[i + 2] ?? 0)) {
        sx += x;
        sy += y;
        n++;
      }
    }
  }
  return n < 20 ? undefined : [sx / n, sy / n];
}

async function measureMisalignment(browser: Browser, baseUrl: string, mode: string, backend: string) {
  const page = await openExperiment(browser, baseUrl, mode, backend);
  try {
    const offsets: number[] = [];
    const dragging = drag(page, performance.now() + DRIVE_MS);
    for (let shot = 0; shot < SCREENSHOTS; shot++) {
      const image = PNG.sync.read(await page.locator('#app').screenshot());
      const marker = centroid(image, (r, g, b) => r > 200 && g < 70 && b < 70);
      const overlay = centroid(image, (r, g, b) => g > 200 && r < 90 && b < 90);
      if (marker && overlay) offsets.push(Math.hypot(marker[0] - overlay[0], marker[1] - overlay[1]));
    }
    await dragging;
    return {
      screenshots: offsets.length,
      misalignmentP50Px: round(percentile(offsets, 50)),
      misalignmentMaxPx: round(Math.max(...offsets)),
    };
  } finally {
    await page.close();
  }
}

const server = await preview({ root: join(ROOT_DIR, 'apps/playground'), logLevel: 'silent', preview: { port: 4174 } });
const baseUrl = server.resolvedUrls?.local[0] ?? 'http://localhost:4174/';
function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const engineName = option('--browser') ?? 'chromium';
const engine = { chromium, firefox, webkit }[engineName];
if (!engine) throw new Error(`Unknown --browser ${engineName}`);
const channel = option('--channel');
const hardware = process.argv.includes('--hardware');
const executablePath = engineName === 'chromium' && !channel ? process.env['VIBEGLOBE_CHROMIUM_PATH'] : undefined;
const browser = await engine.launch({
  ...(engineName === 'chromium' && !hardware ? { args: SOFTWARE_GPU_ARGS } : {}),
  ...(channel ? { channel } : {}),
  ...(executablePath ? { executablePath } : {}),
});
const results: Record<string, unknown>[] = [];
try {
  for (const backend of BACKENDS) {
    for (const mode of MODES) {
      for (const load of [false, true]) {
        const timing = await measureTiming(browser, baseUrl, mode, backend, load);
        results.push({ backend, mode, load, ...timing });
        console.log(JSON.stringify(results.at(-1)));
      }
      const overlay = await measureMisalignment(browser, baseUrl, mode, backend);
      results.push({ backend, mode, load: false, ...overlay });
      console.log(JSON.stringify(results.at(-1)));
    }
  }
} finally {
  await browser.close();
  await server.close();
}

const date = new Date().toISOString();
const device = process.env['VIBEGLOBE_DEVICE'] ?? 'local';
const report = {
  schemaVersion: 1,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT_DIR, encoding: 'utf8' }).trim(),
  date,
  device: {
    name: device,
    os: `${process.platform} ${release()}`,
    browser: `${channel ?? engineName} ${browser.version()}`,
    gpu: hardware ? 'hardware' : 'software (SwiftShader)',
  },
  method: { viewport: VIEWPORT, warmUpMs: WARM_UP_MS, driveMs: DRIVE_MS, load: '30 ms task every 100 ms' },
  results,
};
const outDir = join(ROOT_DIR, 'benchmarks/results', device);
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `offscreen-${date.replace(/[:.]/g, '-')}.json`);
writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Results: ${outFile}`);
