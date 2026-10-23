// Node-side helpers of the network simulation suite (F315, F329): put a session's tiles behind a simulated link,
// record every attempt per tile, and play a navigation path in the page with the frame recorder.
import { resolve } from 'node:path';
import type { Page, Route } from '@playwright/test';
import type { Attempts, NetworkLink } from '../../../scripts/fixtures/network/links.ts';
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
 * fate of each request. Returns the attempts per tile path, filled as the page makes requests.
 */
export async function useLink(page: Page, session: string, link: NetworkLink): Promise<Attempts> {
  const response = await page.request.post(`/_fixture/${session}/rules`, { data: JSON.stringify(link.rules) });
  if (!response.ok()) throw new Error(`fault rules refused: ${await response.text()}`);
  const attempts: Record<string, number[]> = {};
  let index = 0;
  await page.route(`**/fixture-tiles/${session}/**`, async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    (attempts[path] ??= []).push(Date.now());
    const fate = link.intercept(index++);
    if (fate === 'reset') return route.abort('connectionreset');
    if (fate === 'disconnected') return route.abort('internetdisconnected');
    // The page may have closed meanwhile.
    return route.continue().catch(() => undefined);
  });
  return attempts;
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
