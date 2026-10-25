import { expect, test, type Page } from '@playwright/test';
import type { PNG } from 'pngjs';
import { canvasImage, openGlobe, waitForIdle } from './support/globe.ts';
import { fixtureSession, requestLog, waitForStreaming, type LoggedRequest } from './support/imagery.ts';

/**
 * Adaptive loading (M8): what loads ahead and how much detail a moving camera asks for (F285–F288), and the link
 * measured from the engine's own downloads setting flight detail, prefetch and concurrency (F300–F303). Links are the
 * fixture server's shared session links (`linkBytesPerS`, `latencyMs`).
 */
const SLOW = 50_000; // 400 kbps
const MEDIUM = 625_000; // 5 Mbps
const FAST = 6_250_000; // 50 Mbps

test.use({ viewport: { width: 480, height: 320 } });

/**
 * Starts recording, on every frame, the imagery tiles the frame draws (`level/x/y`) into `window.drawnTiles`, and the
 * surface tiles it shows, whose imagery it wants, into `window.visibleTiles`.
 */
async function recordDrawn(page: Page): Promise<void> {
  await page.evaluate(() => {
    const globe = window.vibeglobePlayground?.globe;
    const drawn = new Set<string>();
    const visible = new Set<string>();
    Object.assign(window, { drawnTiles: drawn, visibleTiles: visible });
    globe?.on('frame', () => {
      for (const tile of globe.surfaceTiles()) {
        if (tile.root !== 'mercator') continue;
        visible.add(`${tile.level}/${tile.x}/${tile.y}`);
        if (tile.imageryLevel === null) continue;
        const shift = 2 ** (tile.level - tile.imageryLevel);
        drawn.add(`${tile.imageryLevel}/${Math.floor(tile.x / shift)}/${Math.floor(tile.y / shift)}`);
      }
    });
  });
}

async function drawnTiles(page: Page, set: 'drawnTiles' | 'visibleTiles' = 'drawnTiles'): Promise<Set<string>> {
  return new Set(
    await page.evaluate((name) => [...((window as unknown as Record<string, Set<string>>)[name] ?? [])], set),
  );
}

const keyOf = (request: LoggedRequest): string => `${request.level}/${request.x}/${request.y}`;

/** The tiles of `keys` (`level/x/y`) with all their ancestors: what was wanted, or requested as a stand-in for it. */
function withAncestors(keys: Set<string>): Set<string> {
  const all = new Set<string>();
  for (const key of keys) {
    let [level = 0, x = 0, y = 0] = key.split('/').map(Number);
    while (level >= 0 && !all.has(`${level}/${x}/${y}`)) {
      all.add(`${level}/${x}/${y}`);
      [level, x, y] = [level - 1, Math.floor(x / 2), Math.floor(y / 2)];
    }
  }
  return all;
}

/** Pixels whose channels are all near zero. */
function blackPixels(image: PNG): number {
  let count = 0;
  for (let i = 0; i < image.data.length; i += 4)
    if ((image.data[i] ?? 0) <= 8 && (image.data[i + 1] ?? 0) <= 8 && (image.data[i + 2] ?? 0) <= 8) count++;
  return count;
}

/** Share of pixels that differ by more than 24 in a channel. */
function changed(a: PNG, b: PNG): number {
  let count = 0;
  for (let i = 0; i < a.data.length; i += 4)
    for (let c = 0; c < 3; c++)
      if (Math.abs((a.data[i + c] ?? 0) - (b.data[i + c] ?? 0)) > 24) {
        count++;
        break;
      }
  return count / (a.width * a.height);
}

/** Pans east by `degrees` over `durationMs` with an ease, and waits for its end. */
async function pan(page: Page, degrees: number, durationMs: number): Promise<void> {
  await page.evaluate(
    async ({ degrees: d, durationMs: ms }) => {
      const globe = window.vibeglobePlayground?.globe;
      if (!globe) return;
      const { longitudeDeg, latitudeDeg, zoom } = globe.camera;
      await globe.easeTo({ longitudeDeg: longitudeDeg + d, latitudeDeg, zoom }, { durationMs: ms });
    },
    { degrees, durationMs },
  );
}

/** Jumps to zoom 9 and measures, frame by frame in the page, the milliseconds until every wanted tile is drawn. */
function timeToCompleteView(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const globe = window.vibeglobePlayground?.globe;
        const start = performance.now();
        globe?.jumpTo({ zoom: 9 });
        const check = (): void => {
          const s = globe?.imageryStats();
          const idle = s !== undefined && s.queued + s.loading + s.decoding + s.uploadsPending === 0;
          // Complete: nothing loading and every tile at its own detail, not a coarser stand-in (motion detail, F288).
          if (idle && globe?.surfaceTiles().every((t) => t.root !== 'mercator' || t.imageryLevel === t.level))
            resolve(performance.now() - start);
          else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      }),
  );
}

const stats = (page: Page): Promise<{ bandwidth: number; latency: number }> =>
  page.evaluate(() => {
    const imagery = window.vibeglobePlayground?.globe.imageryStats();
    return { bandwidth: imagery?.bandwidthBitsPerSecond ?? Number.NaN, latency: imagery?.latencyMs ?? Number.NaN };
  });

test.describe('what loads ahead and at which detail (F285–F288)', () => {
  test('with prefetch and flight preloading off for a source, it requests only what the view needs; the other prefetches (F285)', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const session = await fixtureSession(page);
    await openGlobe(page, `session=${session}&imagery=world&prefetch=0&overlays=smooth:0.5&lon=10&lat=45&zoom=7`);
    await recordDrawn(page);
    await waitForStreaming(page);
    await pan(page, 3, 2000);
    await page.evaluate(() =>
      window.vibeglobePlayground?.globe.flyTo({ longitudeDeg: 2.35, latitudeDeg: 48.85, zoom: 8 }),
    );
    await waitForStreaming(page);
    // Every tile requested was wanted by a frame: one of its surface tiles, or an ancestor standing in for them.
    const drawn = withAncestors(await drawnTiles(page, 'visibleTiles'));
    const log = await requestLog(page, session);
    const outside = (source: string): string[] =>
      log.filter((r) => r.source === source && r.level > 3 && !drawn.has(keyOf(r))).map(keyOf);
    console.log(
      '[adaptive] F285 outside',
      JSON.stringify(outside('world')),
      'visible',
      JSON.stringify([...drawn].filter((k) => Number(k.split('/')[0]) > 3).sort()),
    );
    expect(outside('world')).toEqual([]);
    expect(outside('smooth').length).toBeGreaterThan(0);
  });

  test('a flight loads its destination at the arrival levels at once and arrives complete, without black pixels or popping (F286)', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const session = await fixtureSession(page, [{ latencyMs: 100 }]);
    await openGlobe(page, `session=${session}&imagery=world&lon=9.19&lat=45.46&zoom=9`);
    await waitForStreaming(page);
    const before = (await requestLog(page, session)).length;
    await page.evaluate(() => {
      document.body.dataset['scenario'] = 'flying';
      void window.vibeglobePlayground?.globe
        .flyTo({ longitudeDeg: 139.7, latitudeDeg: 35.7, zoom: 9 }, { durationMs: 8000 })
        .then(() => (document.body.dataset['scenario'] = 'done'));
    });
    await page.waitForTimeout(1500);
    const early = (await requestLog(page, session)).slice(before).map(keyOf);
    // The final descent and the arrival: every captured frame complete.
    const frames: PNG[] = [];
    while ((await page.evaluate(() => document.body.dataset['scenario'])) !== 'done') {
      frames.push(await canvasImage(page));
      for (const frame of frames.slice(-1)) expect(blackPixels(frame)).toBe(0);
    }
    const arrival = await canvasImage(page);
    await waitForIdle(page);
    const settled = await canvasImage(page);
    const arrivalTiles = await page.evaluate(() =>
      (window.vibeglobePlayground?.globe.surfaceTiles() ?? [])
        .filter((t) => t.root === 'mercator' && t.imageryLevel !== null)
        .map((t) => {
          const level = t.imageryLevel ?? 0;
          const shift = 2 ** (t.level - level);
          return `${level}/${Math.floor(t.x / shift)}/${Math.floor(t.y / shift)}`;
        }),
    );
    const requestedEarly = arrivalTiles.filter((key) => early.includes(key));
    console.log(
      `[adaptive] F286: ${requestedEarly.length}/${new Set(arrivalTiles).size} arrival tiles requested in the first 1.5 s`,
    );
    expect(requestedEarly.length / arrivalTiles.length).toBeGreaterThan(0.8);
    expect(blackPixels(arrival)).toBe(0);
    // Preloaded, the arrival view does not change once the camera stops: no tile pops in.
    expect(changed(arrival, settled)).toBeLessThan(0.02);
  });

  test('along a flight it loads what will be visible, at the detail the moving camera shows (F287)', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const session = await fixtureSession(page);
    await openGlobe(page, `session=${session}&imagery=world&lon=9.19&lat=45.46&zoom=9`);
    await waitForStreaming(page);
    await recordDrawn(page);
    const before = (await requestLog(page, session)).length;
    const destination = await page.evaluate(async () => {
      const globe = window.vibeglobePlayground?.globe;
      await globe?.flyTo({ longitudeDeg: 139.7, latitudeDeg: 35.7, zoom: 9 }, { durationMs: 10_000 });
      return globe?.surfaceTiles().map((t) => `${t.imageryLevel}`) ?? [];
    });
    const drawn = withAncestors(await drawnTiles(page));
    const path = (await requestLog(page, session))
      .slice(before)
      .filter((r) => !(Math.abs(r.x / 2 ** r.level - (139.7 + 180) / 360) < 0.02));
    const shown = path.filter((r) => drawn.has(keyOf(r)));
    console.log(
      '[adaptive] F287 not drawn:',
      path
        .filter((r) => !drawn.has(keyOf(r)))
        .map((r) => `${keyOf(r)}@${Math.round(r.startMs)}-${Math.round(r.endMs ?? 0)}${r.aborted ? 'x' : ''}`)
        .join(' '),
    );
    console.log(
      `[adaptive] F287: ${shown.length}/${path.length} path requests drawn; arrival levels ${destination.join(',')}`,
    );
    expect(shown.length / path.length).toBeGreaterThanOrEqual(0.95);
  });

  test('a fast pan loads fewer and coarser tiles than a slow one, without black pixels, and refines once stopped (F288)', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const results: { count: number; meanLevel: number }[] = [];
    for (const durationMs of [8000, 1200]) {
      const session = await fixtureSession(page);
      await openGlobe(page, `session=${session}&imagery=world&lon=0&lat=45&zoom=9`);
      await waitForStreaming(page);
      const before = (await requestLog(page, session)).length;
      const panning = pan(page, 6, durationMs);
      const start = Date.now();
      while (Date.now() - start < durationMs - 200) expect(blackPixels(await canvasImage(page))).toBe(0);
      await panning;
      const during = (await requestLog(page, session)).slice(before);
      results.push({
        count: during.length,
        meanLevel: during.reduce((sum, r) => sum + r.level, 0) / Math.max(1, during.length),
      });
      // Stopped: full detail, every tile at its own level.
      await waitForStreaming(page);
      const full = await page.evaluate(() =>
        (window.vibeglobePlayground?.globe.surfaceTiles() ?? []).every(
          (t) => t.root !== 'mercator' || t.imageryLevel === t.level,
        ),
      );
      expect(full).toBe(true);
    }
    const [slow, fast] = results;
    console.log(`[adaptive] F288: slow pan ${JSON.stringify(slow)}, fast pan ${JSON.stringify(fast)}`);
    expect(fast?.count ?? 0).toBeLessThan(slow?.count ?? 0);
    expect(fast?.meanLevel ?? 99).toBeLessThan(slow?.meanLevel ?? 0);
  });
});

test.describe('the measured link (F300–F303)', () => {
  test('the bandwidth estimate converges within 20% of the link at 400 kbps, 5 Mbps and 50 Mbps within 10 s (F300)', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    // Photo-sized tiles (512 px JPEG, about 40 kB, as real imagery): a 50 Mbps link moves a few-kilobyte tile in less
    // time than a response takes to handle. A first pass without a link has the fixture server encode them all, so
    // its encoding never stalls the measured link.
    const tiles = 'imagery=world&imageryTileSize=512&imageryFormat=jpg';
    const route = async (step: number): Promise<void> =>
      page.evaluate((s) => {
        window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: 10 + 3 * s, latitudeDeg: 45, zoom: 8 });
      }, step);
    await openGlobe(page, `session=${await fixtureSession(page)}&${tiles}&lon=10&lat=45&zoom=8`);
    for (let step = 0; step < 10; step++) {
      await route(step);
      await waitForStreaming(page);
    }
    for (const bytesPerS of [SLOW, MEDIUM, FAST]) {
      const session = await fixtureSession(page, [{ linkBytesPerS: bytesPerS }]);
      await openGlobe(page, `session=${session}&${tiles}&lon=10&lat=45&zoom=8&debug=1`);
      // Keep loading: a new area every second.
      const start = Date.now();
      let estimate = Number.NaN;
      for (let step = 0; Date.now() - start < 10_000; step++) {
        await route(step);
        await page.waitForTimeout(1000);
        estimate = (await stats(page)).bandwidth;
        if (Math.abs(estimate / (bytesPerS * 8) - 1) < 0.2) break;
      }
      console.log(`[adaptive] F300: link ${(bytesPerS * 8) / 1e6} Mbps, estimate ${(estimate / 1e6).toFixed(2)} Mbps`);
      expect(Math.abs(estimate / (bytesPerS * 8) - 1)).toBeLessThan(0.2);
      await expect(page.locator('[aria-label="Engine diagnostics"]')).toContainText('bandwidth');
    }
  });

  test('a flight requests coarser detail on a slow link, and both arrive at full detail without black pixels (F301)', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const finest: number[] = [];
    for (const bytesPerS of [SLOW, FAST]) {
      const session = await fixtureSession(page, [{ linkBytesPerS: bytesPerS }]);
      // Prefetch off on both links (F285), so neither run starts with the path already loaded: only flight detail differs.
      await openGlobe(page, `session=${session}&imagery=world&prefetch=0&lon=9.19&lat=45.46&zoom=7`);
      await waitForStreaming(page);
      const before = (await requestLog(page, session)).length;
      const startTiles = await page.evaluate(() =>
        (window.vibeglobePlayground?.globe.surfaceTiles() ?? []).map((t) => `${t.level}/${t.x}/${t.y}`),
      );
      const flight = page.evaluate(() =>
        window.vibeglobePlayground?.globe.flyTo(
          { longitudeDeg: 139.7, latitudeDeg: 35.7, zoom: 7 },
          { durationMs: 20_000 },
        ),
      );
      const start = Date.now();
      while (Date.now() - start < 19_500) expect(blackPixels(await canvasImage(page))).toBe(0);
      await flight;
      // Requests the flight made (before it ended), its destination preload included (F286: selected at the flight's
      // detail), not the start view's tiles (retried on the slow link after a timeout).
      const log = await requestLog(page, session);
      const startView = withAncestors(new Set([...startTiles, ...log.slice(0, before).map(keyOf)]));
      const path = log.slice(before).filter((r) => r.startMs !== undefined && !startView.has(keyOf(r)));
      finest.push(Math.max(...path.map((r) => r.level)));
      await waitForStreaming(page);
      const full = await page.evaluate(() =>
        (window.vibeglobePlayground?.globe.surfaceTiles() ?? []).every(
          (t) => t.root !== 'mercator' || t.imageryLevel === t.level,
        ),
      );
      expect(full).toBe(true);
    }
    console.log(`[adaptive] F301: finest level along the flight: slow ${finest[0]}, fast ${finest[1]}`);
    expect(finest[0] ?? 99).toBeLessThan(finest[1] ?? 0);
  });

  test('prefetch loads more on a fast link and nothing ahead of visible tiles on a slow one (F302)', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const prefetched: number[] = [];
    for (const bytesPerS of [SLOW, FAST]) {
      const session = await fixtureSession(page, [{ linkBytesPerS: bytesPerS }]);
      await openGlobe(page, `session=${session}&imagery=world&lon=10&lat=45&zoom=8`);
      await recordDrawn(page);
      await waitForStreaming(page);
      await pan(page, 0.5, 3000);
      await waitForStreaming(page);
      const drawn = withAncestors(await drawnTiles(page));
      const log = (await requestLog(page, session)).filter((r) => r.level > 3);
      // Once the link is measured (after the first responses), anything requested that no frame drew is prefetch.
      prefetched.push(log.slice(6).filter((r) => !drawn.has(keyOf(r))).length);
    }
    console.log(`[adaptive] F302: prefetched tiles: slow ${prefetched[0]}, fast ${prefetched[1]}`);
    expect(prefetched[0]).toBe(0);
    expect(prefetched[1] ?? 0).toBeGreaterThan(0);
  });

  test('concurrency follows the link within the hosts limits, and completes a view as fast as the best fixed one (F303)', async ({
    page,
  }) => {
    test.setTimeout(900_000);
    const ROUNDS = 3;
    const SETTINGS = ['adaptive', '2', '6'];
    const links: { name: string; rules: unknown[] }[] = [
      { name: '400 kbps', rules: [{ linkBytesPerS: SLOW }] },
      { name: '50 Mbps', rules: [{ linkBytesPerS: FAST }] },
      { name: '500 ms', rules: [{ latencyMs: 500, linkBytesPerS: FAST }] },
    ];
    for (const link of links) {
      const samples: Record<string, number[]> = { adaptive: [], '2': [], '6': [] };
      let mostAdaptive = 0;
      // Three rounds, each setting timed by its best run: a view completes in a few hundred milliseconds on a fast
      // link, where single runs on CI's runner vary by more than the 10% compared, and the first view of a round is the
      // slowest (measured 2026-10-24), so the order rotates and each setting runs once in each place.
      for (let round = 0; round < ROUNDS; round++)
        for (const perHost of SETTINGS.map((_, i) => SETTINGS[(i + round) % SETTINGS.length] ?? 'adaptive')) {
          const session = await fixtureSession(page, link.rules);
          const fixed = perHost === 'adaptive' ? '' : `&perHost=${perHost}&adaptive=0`;
          await openGlobe(page, `session=${session}&imagery=world&lon=10&lat=45&zoom=6${fixed}`);
          await waitForStreaming(page);
          samples[perHost]?.push(await timeToCompleteView(page));
          await waitForStreaming(page);
          if (perHost !== 'adaptive') continue;
          const log = (await requestLog(page, session)).filter((r) => r.endMs !== undefined);
          // Most requests in flight at once, after the link was measured (the first six responses).
          const measured = log.slice(6);
          mostAdaptive = Math.max(
            mostAdaptive,
            ...measured.map((r) => measured.filter((o) => o.startMs <= r.startMs && (o.endMs ?? 0) > r.startMs).length),
          );
        }
      const times = Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, Math.min(...values)]));
      console.log(`[adaptive] F303 ${link.name}: most in flight ${mostAdaptive}, times ${JSON.stringify(times)}`);
      expect(mostAdaptive).toBeLessThanOrEqual(6);
      if (link.name === '400 kbps') expect(mostAdaptive).toBeLessThanOrEqual(2);
      else expect(mostAdaptive).toBeGreaterThan(2);
      const best = Math.min(times['2'] ?? Infinity, times['6'] ?? Infinity);
      expect(times['adaptive'] ?? Infinity).toBeLessThanOrEqual(best * 1.1);
    }
  });
});
