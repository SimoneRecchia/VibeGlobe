// Shared probes of the robustness suite (track G, ADR 0161): the page's errors of every kind, the browser's worker
// count, and a seeded generator so a failing random run replays from its seed.
import type { Browser, Page } from '@playwright/test';

/** Every uncaught exception, unhandled rejection and console error of a page, as text, oldest first. */
export interface PageErrors {
  readonly uncaught: string[];
  readonly rejections: string[];
  readonly console: string[];
}

/**
 * Collects the page's errors from now on. Unhandled rejections are also recorded in the page itself (the
 * `unhandledrejection` event), so one the browser reports only as a console message is not missed.
 */
export async function collectErrors(page: Page): Promise<PageErrors> {
  const errors: PageErrors = { uncaught: [], rejections: [], console: [] };
  page.on('pageerror', (error) => errors.uncaught.push(String(error.stack ?? error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.console.push(message.text());
  });
  await page.exposeFunction('robustnessRejection', (reason: string) => errors.rejections.push(reason));
  await page.addInitScript(() => {
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason as { stack?: string } | undefined;
      void (window as unknown as { robustnessRejection: (r: string) => Promise<void> }).robustnessRejection(
        String(reason?.stack ?? reason),
      );
    });
  });
  return errors;
}

/** Errors of the kinds every robustness scenario forbids, minus those `allowed` matches (expected, typed reports). */
export function unexpected(errors: PageErrors, allowed: readonly RegExp[] = []): string[] {
  return [...errors.uncaught, ...errors.rejections, ...errors.console].filter(
    (text) => !allowed.some((pattern) => pattern.test(text)),
  );
}

/** The number of dedicated workers the browser runs (every page of the session). */
export async function workerCount(browser: Browser): Promise<number> {
  const cdp = await browser.newBrowserCDPSession();
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.filter((target) => target.type === 'worker').length;
  } finally {
    await cdp.detach();
  }
}

/** mulberry32, a small seeded generator returning numbers in [0, 1). */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The seed of a run: `VIBEGLOBE_ROBUSTNESS_SEED` to replay one, else a fresh one (printed by the caller). */
export function runSeed(): number {
  const fixed = process.env['VIBEGLOBE_ROBUSTNESS_SEED'];
  return fixed ? Number(fixed) : Math.floor(Math.random() * 2 ** 31);
}

/** A count scaled for development runs: `VIBEGLOBE_ROBUSTNESS_SCALE` (default 1) multiplies the entry's count. */
export function scaled(count: number): number {
  const scale = Number(process.env['VIBEGLOBE_ROBUSTNESS_SCALE'] ?? 1);
  return Math.max(1, Math.round(count * scale));
}
