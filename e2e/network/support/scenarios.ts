// Shared setup of the network suite's scenarios (F315, F329): the packages, health checks and clock every spec uses.
import { expect, type Page } from '@playwright/test';
import type { PathReport } from './frames-page.ts';
import { ROME } from './network.ts';

export const BACKENDS = ['webgpu', 'webgl2'] as const;
export type Backend = (typeof BACKENDS)[number];
/** Black: no channel reaches this (the fixture and base imagery always have a brighter channel). */
export const BLACK_BELOW = 8;
export const HEALTH = { minIntervalMs: 300, maxIntervalMs: 4000 };
/** Engine time per drawn frame: 60 Hz. */
export const STEP_MS = 1000 / 60;

/** The base: a world package of levels 0–3 from the session's `world` tiles. */
export function worldBase(session: string) {
  return {
    id: 'world-base',
    sourceId: 'world',
    pattern: 'world',
    session,
    bounds: { westDeg: -180, southDeg: -85, eastDeg: 180, northDeg: 85 },
    minLevel: 0,
    maxLevel: 3,
    version: '1',
  };
}

/** Detail around Rome, where the paths start: levels 0–10. */
export function romeDetail(session: string) {
  return {
    ...worldBase(session),
    id: 'rome',
    bounds: { westDeg: ROME.longitudeDeg - 1.5, southDeg: 40.8, eastDeg: 14.5, northDeg: 43 },
    maxLevel: 10,
  };
}

/** Holes, black pixels and pops of a recorded path: all zero (the report, with the first defect, as the message). */
export function expectClean(report: PathReport, minStaticFrames = 100): void {
  expect([report.holes, report.dark, report.pops], JSON.stringify(report)).toEqual([0, 0, 0]);
  expect(report.staticFrames).toBeGreaterThanOrEqual(minStaticFrames);
}

/** Waits until the offline engine reports `state`. */
export async function expectConnectivity(page: Page, state: 'online' | 'offline'): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.offlineHarness?.offline?.connectivity), { timeout: 20_000 })
    .toBe(state);
}
