// Node-side helpers of the network simulation suite (F315, F329): put a session's tiles behind a simulated link,
// record every attempt per tile, and play a navigation path in the page with the frame recorder.
import { resolve } from 'node:path';
import type { Page, Route } from '@playwright/test';
import type { Attempt, Attempts, NetworkLink } from '../../../scripts/fixtures/network/links.ts';
import type { PathReport, PathStep, recordPath as recordInPage } from './frames-page.ts';

export type { PathReport, PathStep };

const RECORDER = `/@fs${resolve('e2e/network/support/frames-page.ts')}`;

/** Rome, where every scenario starts: the world base package covers it to level 3, the network beyond. */
export const ROME = { longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 8 };

/** The navigation scenario: a zoom, a pan and a flight, each followed by frames with the camera still. */
export const NAVIGATION: readonly PathStep[] = [
  { jump: ROME },
  { hold: 20 },
  { move: { ...ROME, zoom: 9.5 }, frames: 30 },
  { hold: 40 },
  { move: { ...ROME, longitudeDeg: 13.1, zoom: 9.5 }, frames: 30 },
  { hold: 40 },
  { fly: { longitudeDeg: 2.35, latitudeDeg: 48.85, zoom: 8 }, durationMs: 3000 },
  { hold: 60 },
];

/** Health checks probe the source's root tile, which the base package serves: every request for it is a check. */
export const isHealthCheck = (key: string): boolean => key.endsWith('/0/0/0.png');

/**
 * Puts the fixture tiles of `session` behind `link`: the server's fault rules for the session, and the browser-side
 * fate of each request. Returns a reader of the attempts per tile path, filled as the page makes requests.
 */
export async function useLink(page: Page, session: string, link: NetworkLink): Promise<() => Promise<Attempts>> {
  const response = await page.request.post(`/_fixture/${session}/rules`, { data: JSON.stringify(link.rules) });
  if (!response.ok()) throw new Error(`fault rules refused: ${await response.text()}`);
  const failed: Record<string, boolean[]> = {};
  let index = 0;
  await page.route(`**/fixture-tiles/${session}/**`, async (route: Route) => {
    const fate = link.intercept(index++);
    (failed[new URL(route.request().url()).pathname] ??= []).push(fate !== 'continue');
    if (fate === 'reset') return route.abort('connectionreset');
    if (fate === 'disconnected') return route.abort('internetdisconnected');
    // The page may have closed meanwhile.
    return route.continue().catch(() => undefined);
  });
  // Each request is timed where it starts, in the page, with the globe's frame then: a route event reaches Node late
  // when the machine is busy, and on the manual clock the engine's waits are counted in frames. The tile transport and
  // the health checks call the page's `fetch`.
  await page.evaluate(() => {
    const starts: [string, number, number][] = [];
    (window as unknown as { fetchStarts: typeof starts }).fetchStarts = starts;
    const frames = new WeakMap<object, { frame: number }>();
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const globe = window.offlineHarness?.globe;
      let counter = globe ? frames.get(globe) : undefined;
      if (globe && !counter) {
        const created = { frame: 0 };
        globe.on('frame', (event) => (created.frame = event.frameNumber));
        frames.set(globe, (counter = created));
      }
      const url = input instanceof Request ? input.url : String(input);
      starts.push([
        new URL(url, location.href).pathname,
        performance.timeOrigin + performance.now(),
        counter?.frame ?? 0,
      ]);
      return original(input, init);
    };
  });
  return async () => {
    const starts = await page.evaluate(
      () => (window as unknown as { fetchStarts: [string, number, number][] }).fetchStarts,
    );
    const attempts: Record<string, Attempt[]> = {};
    for (const [path, outcomes] of Object.entries(failed)) {
      // Every intercepted request was timed in the page, in the same order, or the outcomes would not match; the page
      // may have started one more that has not reached the route yet.
      const timed = starts.filter(([p]) => p === path).slice(0, outcomes.length);
      if (timed.length !== outcomes.length)
        throw new Error(`${path}: ${String(outcomes.length)} requests intercepted, ${String(timed.length)} timed`);
      attempts[path] = timed.map(([, startMs, frame], i) => ({ startMs, frame, failed: outcomes[i] ?? false }));
    }
    return attempts;
  };
}

/** Plays `steps` in the offline harness's globe and returns what the frame recorder found. */
export async function recordPath(page: Page, steps: readonly PathStep[], darkBelow: number): Promise<PathReport> {
  return page.evaluate(
    async ([url, s, dark]) => {
      const recorder = (await import(/* @vite-ignore */ url)) as { recordPath: typeof recordInPage };
      const globe = window.offlineHarness?.globe;
      if (!globe) throw new Error('no globe');
      return recorder.recordPath(globe, s, dark);
    },
    [RECORDER, steps, darkBelow] as const,
  );
}

/** A fresh fixture session id: the server keeps a session's rules and hit counts for its lifetime. */
export function sessionId(name: string): string {
  return `net-${name.replace(/\W+/g, '-')}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
