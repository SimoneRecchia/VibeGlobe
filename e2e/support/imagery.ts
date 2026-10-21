import { expect, type Page } from '@playwright/test';
import { waitForIdle } from './globe.js';

/** Helpers for tests of tiled imagery against the playground's fixture tile server (M3 plan §4.1). */

/** A fresh fixture-server session with its own fault rules and request log (M3 plan §4.1). */
export async function fixtureSession(page: Page, rules: unknown[] = []): Promise<string> {
  const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const response = await page.request.post(`/_fixture/${id}/rules`, { data: JSON.stringify(rules) });
  expect(response.status()).toBe(204);
  return id;
}

/** One request in the fixture server's log. */
export interface LoggedRequest {
  path: string;
  level: number;
  x: number;
  y: number;
  startMs: number;
  endMs?: number;
}

/** The fixture server's log of a session's requests. */
export async function requestLog(page: Page, session: string): Promise<LoggedRequest[]> {
  return (await (await page.request.get(`/_fixture/${session}/log`)).json()) as LoggedRequest[];
}

/**
 * Waits until every Mercator tile of the view shows imagery of its own level (the polar caps keep the base image),
 * then for the engine to go idle.
 */
export async function waitForImagery(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const globe = window.vibeglobePlayground?.globe;
          const tiles = globe?.surfaceTiles() ?? [];
          return tiles.length > 0 && tiles.every((t) => t.root !== 'mercator' || t.imageryLevel === t.level);
        }),
      { timeout: 60_000 },
    )
    .toBe(true);
  await waitForIdle(page);
}

/** The Web Mercator tile at a level that contains a position. */
export function mercatorTile(level: number, lonDeg: number, latDeg: number): { x: number; y: number } {
  const n = 2 ** level;
  const lat = (latDeg * Math.PI) / 180;
  return {
    x: Math.floor(((lonDeg + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * n),
  };
}

/** The drawn surface tile under the screen center, with the imagery level it shows. */
export async function centerTile(page: Page): Promise<{ level: number; imageryLevel: number | null }> {
  return page.evaluate(() => {
    const globe = window.vibeglobePlayground?.globe;
    const host = document.querySelector('#globe');
    const center = globe?.screenToGeo({ xPx: (host?.clientWidth ?? 0) / 2, yPx: (host?.clientHeight ?? 0) / 2 });
    const tile = globe
      ?.surfaceTiles()
      .find(
        (t) =>
          center &&
          t.westDeg <= center.longitudeDeg &&
          center.longitudeDeg <= t.eastDeg &&
          t.southDeg <= center.latitudeDeg &&
          center.latitudeDeg <= t.northDeg,
      );
    if (!tile) throw new Error('no tile under the center');
    return { level: tile.level, imageryLevel: tile.imageryLevel };
  });
}
