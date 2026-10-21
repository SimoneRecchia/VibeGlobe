// ADR 0012's probes, moved to M2 by ADR 0013 #6: on the pinned browser, are rendered frames deterministic across browser
// launches, how far do the two backends differ on the same view, what does a canvas capture cost, and does
// `--deterministic-mode` change frame pacing? Needs `npm run build` (it serves the playground's production build).
// Results go to benchmarks/results/<device>/probes-<date>.json (device from VIBEGLOBE_DEVICE, default "local").
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { preview } from 'vite';
import { gpuArgs } from '../scripts/browser/gpu-args.ts';
import { ROOT_DIR } from '../scripts/workspace.ts';

const BACKENDS = ['webgpu', 'webgl2'] as const;
const VIEWPORT = { width: 640, height: 360 };
/** The canonical view: Europe from orbit, the view of the visual baselines' `europe` case. */
const VIEW = 'lon=12&lat=45&zoom=4';
const CAPTURES = 10;
const PACING_MS = 5000;

const executablePath = process.env['VIBEGLOBE_CHROMIUM_PATH'];

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? Number.NaN;
}

async function launch(extraArgs: string[] = []): Promise<Browser> {
  return chromium.launch({ args: [...gpuArgs(), ...extraArgs], ...(executablePath ? { executablePath } : {}) });
}

/** Opens the canonical view and waits until the engine is idle with every tile drawn. */
async function openView(browser: Browser, baseUrl: string, backend: string): Promise<Page> {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  page.setDefaultTimeout(60_000);
  await page.goto(`${baseUrl}?backend=${backend}&${VIEW}`);
  await page.waitForFunction(() => window.vibeglobePlayground !== undefined);
  await page.evaluate(async () => window.vibeglobePlayground?.globe.ready);
  await page.addStyleTag({ content: '#status, #cursor { visibility: hidden !important; }' });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const globe = window.vibeglobePlayground?.globe;
        let last = -1;
        // At most 20 s: a browser whose frames never stop is reported by the probes, not waited for.
        const deadline = performance.now() + 20_000;
        const check = (): void => {
          const now = globe?.frameNumber ?? 0;
          if (now === last || performance.now() > deadline) resolve();
          else {
            last = now;
            setTimeout(check, 300);
          }
        };
        check();
      }),
  );
  return page;
}

async function capture(page: Page): Promise<Buffer> {
  return page.locator('#globe').screenshot();
}

function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The SHA-1 of the canonical view's pixels per backend, in a fresh browser launch. */
async function fingerprints(baseUrl: string): Promise<Record<string, string>> {
  const browser = await launch();
  try {
    const out: Record<string, string> = {};
    for (const backend of BACKENDS) {
      const page = await openView(browser, baseUrl, backend);
      out[backend] = sha1(PNG.sync.read(await capture(page)).data);
      await page.close();
    }
    return out;
  } finally {
    await browser.close();
  }
}

/** Pixels that differ between the backends, with and without pixelmatch's anti-aliasing detection. */
async function backendConsistency(baseUrl: string): Promise<Record<string, number>> {
  const browser = await launch();
  try {
    const images: PNG[] = [];
    for (const backend of BACKENDS) {
      const page = await openView(browser, baseUrl, backend);
      images.push(PNG.sync.read(await capture(page)));
      await page.close();
    }
    const [a, b] = images as [PNG, PNG];
    const pixels = a.width * a.height;
    let exact = 0;
    let maxChannel = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      const d = Math.max(
        Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0)),
        Math.abs((a.data[i + 1] ?? 0) - (b.data[i + 1] ?? 0)),
        Math.abs((a.data[i + 2] ?? 0) - (b.data[i + 2] ?? 0)),
      );
      if (d > 0) exact++;
      maxChannel = Math.max(maxChannel, d);
    }
    const options = { threshold: 0.1 };
    const withAa = pixelmatch(a.data, b.data, null, a.width, a.height, options);
    const countingAa = pixelmatch(a.data, b.data, null, a.width, a.height, { ...options, includeAA: true });
    return {
      pixels,
      exactlyDifferent: exact,
      maxChannelDifference: maxChannel,
      pixelmatchDifferent: withAa,
      pixelmatchDifferentCountingAntiAliasing: countingAa,
      pixelmatchDifferentPercent: (100 * withAa) / pixels,
    };
  } finally {
    await browser.close();
  }
}

/** Milliseconds per canvas capture (screenshot and PNG decode), per backend. */
async function captureCost(baseUrl: string): Promise<Record<string, { medianMs: number; maxMs: number }>> {
  const browser = await launch();
  try {
    const out: Record<string, { medianMs: number; maxMs: number }> = {};
    for (const backend of BACKENDS) {
      const page = await openView(browser, baseUrl, backend);
      const times: number[] = [];
      for (let i = 0; i < CAPTURES; i++) {
        const start = performance.now();
        PNG.sync.read(await capture(page));
        times.push(performance.now() - start);
      }
      out[backend] = { medianMs: median(times), maxMs: Math.max(...times) };
      await page.close();
    }
    return out;
  } finally {
    await browser.close();
  }
}

/** requestAnimationFrame intervals over a few seconds, with and without `--deterministic-mode`. */
async function pacing(baseUrl: string): Promise<Record<string, { p50Ms: number; p95Ms: number; frames: number }>> {
  const out: Record<string, { p50Ms: number; p95Ms: number; frames: number }> = {};
  for (const [name, args] of [
    ['default', []],
    ['deterministic-mode', ['--deterministic-mode']],
  ] as const) {
    const browser = await launch([...args]);
    try {
      const page = await openView(browser, baseUrl, 'webgl2');
      const intervals = await page.evaluate(
        (durationMs) =>
          new Promise<number[]>((resolve) => {
            const times: number[] = [];
            const done = (): void => resolve(times.slice(1).map((t, i) => t - (times[i] ?? t)));
            // Also ends by the clock, in case the browser stops producing frames.
            const timer = setTimeout(done, durationMs * 2);
            const tick = (time: number): void => {
              times.push(time);
              if (time - (times[0] ?? time) < durationMs) requestAnimationFrame(tick);
              else {
                clearTimeout(timer);
                done();
              }
            };
            requestAnimationFrame(tick);
          }),
        PACING_MS,
      );
      out[name] = { p50Ms: percentile(intervals, 50), p95Ms: percentile(intervals, 95), frames: intervals.length };
    } finally {
      await browser.close();
    }
  }
  return out;
}

async function step<T>(name: string, work: Promise<T>): Promise<T> {
  console.log(`${name}…`);
  return work;
}

const server = await preview({ root: join(ROOT_DIR, 'apps/playground'), logLevel: 'silent', preview: { port: 4175 } });
const baseUrl = server.resolvedUrls?.local[0] ?? 'http://localhost:4175/';
let report: Record<string, unknown>;
try {
  console.log('determinism…');
  const first = await fingerprints(baseUrl);
  const second = await fingerprints(baseUrl);
  const versionBrowser = await launch();
  const browserVersion = versionBrowser.version();
  await versionBrowser.close();
  report = {
    schemaVersion: 1,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT_DIR, encoding: 'utf8' }).trim(),
    date: new Date().toISOString(),
    device: {
      name: process.env['VIBEGLOBE_DEVICE'] ?? 'local',
      os: `${process.platform} ${release()}`,
      browser: `chromium ${browserVersion}`,
    },
    view: { query: VIEW, ...VIEWPORT },
    determinism: {
      identicalAcrossLaunches: Object.fromEntries(BACKENDS.map((b) => [b, first[b] === second[b]])),
      first,
      second,
    },
    backendConsistency: await step('backend consistency', backendConsistency(baseUrl)),
    captureCost: await step('capture cost', captureCost(baseUrl)),
    pacing: await step('pacing', pacing(baseUrl)),
  };
} finally {
  await server.close();
}

console.log(JSON.stringify(report, null, 2));
const outDir = join(ROOT_DIR, 'benchmarks/results', process.env['VIBEGLOBE_DEVICE'] ?? 'local');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `probes-${String(report['date']).replace(/[:.]/g, '-')}.json`);
writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Results: ${outFile}`);
