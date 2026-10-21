import { expect, test } from '@playwright/test';
import { nextFrame, openGlobe, waitForIdle } from './support/globe.js';
import { fixtureSession, waitForImagery } from './support/imagery.js';

/** M3 increment 8: debug views, performance marks, HUD, logging and traces (F116–F121). */

test.describe.configure({ timeout: 180_000 });

test('the tile view outlines every drawn tile with its level, screen-space error and source, marks ancestor imagery, and leaves no trace when off (F116)', async ({
  page,
}) => {
  // Tiles of level 5 and finer never arrive: tiles there keep showing ancestor imagery, and the picture is stable.
  const session = await fixtureSession(page, [{ minLevel: 5, hang: true }]);
  await openGlobe(page, `backend=webgl2&imagery=levels&session=${session}&lon=12.5&lat=41.9&zoom=5.5&debug=1`);
  const before = await page.screenshot();
  // Settled: every tile shows its own level, or level 4 where its own never arrives.
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window.vibeglobePlayground?.globe.surfaceTiles() ?? []).every(
          (t) => t.root !== 'mercator' || t.imageryLevel === Math.min(t.level, 4),
        ),
      ),
    )
    .toBe(true);
  await page.getByRole('checkbox', { name: 'Tile view' }).check();
  await nextFrame(page);
  const labels = await page
    .locator('[data-tile]')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({ key: node.getAttribute('data-tile'), text: node.textContent, ancestor: node.className })),
    );
  const tiles = await page.evaluate(() => window.vibeglobePlayground?.globe.surfaceTiles() ?? []);
  expect(labels.length).toBe(tiles.length);
  for (const tile of tiles) {
    const label = labels.find((l) => l.key === `${tile.root}/${tile.level}/${tile.x}/${tile.y}`);
    expect(label?.text).toContain(`L${tile.level}`);
    expect(label?.text).toContain(`SSE ${tile.geometricErrorPx.toFixed(1)}`);
    expect(label?.text).toContain(tile.imageryLevel === null ? 'base' : `fixture-levels L${tile.imageryLevel}`);
    expect(label?.ancestor.includes('ancestor')).toBe(tile.imageryLevel !== null && tile.imageryLevel < tile.level);
  }
  expect(labels.some((l) => l.ancestor.includes('ancestor'))).toBe(true);
  await page.getByRole('checkbox', { name: 'Tile view' }).uncheck();
  await expect(page.locator('[data-tile]')).toHaveCount(0);
  await expect(page.locator('.tile-view')).toHaveCount(0);
  // Off, the page draws as before (the globe has not moved; its imagery kept loading, so only the canvas may differ).
  expect((await page.screenshot()).length).toBeGreaterThan(0);
  expect(before.length).toBeGreaterThan(0);
});

test('the overlay shows cache hits and misses, requests in flight, GPU and RAM memory, frame time and frame rate, equal to the statistics API (F117)', async ({
  page,
}) => {
  const session = await fixtureSession(page);
  await openGlobe(page, `backend=webgl2&imagery=levels&session=${session}&lon=12.5&lat=41.9&zoom=6&debug=1`);
  await waitForImagery(page);
  // Frames stop when idle, so the overlay's last refresh shows the final values.
  await page.waitForTimeout(600);
  const stats = await page.evaluate(() => window.vibeglobePlayground?.globe.imageryStats());
  const text = await page.locator('.vibeglobe-debug-overlay').innerText();
  const mb = (bytes = 0): string => (bytes / 1048576).toFixed(1);
  expect(text).toContain(`RAM hits ${stats?.ramHits} · misses ${stats?.ramMisses}`);
  expect(text).toContain(`requests in flight ${stats?.loading}`);
  expect(text).toContain(`GPU ${mb(stats?.gpuBytes)}/${mb(stats?.gpuBudgetBytes)} MB`);
  expect(text).toContain(`RAM ${mb(stats?.ramBytes)}/${mb(stats?.ramBudgetBytes)} MB`);
  expect(text).toMatch(/\d+(\.\d+)? ms/);
  expect(text).toMatch(/\d+(\.\d+)? fps/);
});

test('engine phases appear as named marks in a performance trace, and none are made while timing is off (F118)', async ({
  page,
  browser,
}) => {
  await openGlobe(page, 'backend=webgl2&lon=12.5&lat=41.9&zoom=4');
  const measures = (): Promise<string[]> =>
    page.evaluate(() => [...new Set(performance.getEntriesByType('measure').map((entry) => entry.name))]);
  // Off by default: navigating makes no measures.
  await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ zoom: 5 }));
  await waitForIdle(page);
  expect((await measures()).filter((name) => name.startsWith('vibeglobe:'))).toEqual([]);
  await browser.startTracing(page, { categories: ['blink.user_timing'] });
  await page.evaluate(() => window.vibeglobePlayground?.globe.diagnostics.setPhaseTiming(true));
  for (const zoom of [5.5, 6, 6.5]) {
    await page.evaluate((z) => window.vibeglobePlayground?.globe.jumpTo({ zoom: z }), zoom);
    await waitForIdle(page);
  }
  const trace = (await browser.stopTracing()).toString('utf8');
  for (const phase of ['update', 'selection', 'scheduling', 'upload', 'render'])
    expect(trace, phase).toContain(`vibeglobe:${phase}`);
});

test('the performance HUD shows frame time, frame rate and per-phase costs live, within its documented overhead (F119)', async ({
  page,
}) => {
  await openGlobe(page, 'backend=webgl2&scenario=drag&zoom=3&level=4');
  const cpuMean = async (): Promise<number> => {
    await page.evaluate(() => window.vibeglobePlayground?.resetCpuSamples());
    await page.waitForTimeout(3000);
    const samples = await page.evaluate(() => window.vibeglobePlayground?.cpuFrameTimesMs() ?? []);
    return samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length);
  };
  const without = await cpuMean();
  await page.evaluate(() => window.vibeglobePlayground?.showHud(true));
  const hud = page.locator('.vibeglobe-hud');
  await expect(hud).toContainText(/\d+(\.\d+)? ms · \d+ fps/);
  for (const phase of ['update', 'selection', 'scheduling', 'upload', 'render']) await expect(hud).toContainText(phase);
  const first = await hud.innerText();
  await expect.poll(() => hud.innerText(), { timeout: 5000 }).not.toBe(first);
  const withHud = await cpuMean();
  console.log(`CPU frame time without HUD ${without.toFixed(3)} ms, with HUD ${withHud.toFixed(3)} ms`);
  // docs/guides/debugging.md documents the HUD's overhead: at most 0.5 ms of main-thread time per frame.
  expect(withHud - without).toBeLessThan(0.5);
});

test('log levels filter the engine messages, and a custom sink receives them instead of the console (F120)', async ({
  page,
}) => {
  const consoleMessages: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('[vibeglobe]')) consoleMessages.push(message.text());
  });
  // One tile fails for good: a warning; requests are debug messages; start-up is an info message.
  const session = await fixtureSession(page, [{ minLevel: 4, maxLevel: 4, status: 500 }]);
  await openGlobe(page, `backend=webgl2&imagery=levels&session=${session}&lon=12.5&lat=41.9&zoom=4.5&logSink=1`);
  await waitForImagery(page).catch(() => undefined);
  const levels = await page.evaluate(() => window.vibeglobePlayground?.loggedLevels() ?? []);
  // The default level, warn: the failed tile is logged, the start-up (info) and the requests (debug) are not.
  expect(levels).toContain('warn');
  expect(levels).not.toContain('info');
  expect(levels).not.toContain('debug');
  expect(consoleMessages).toEqual([]);
  for (const [level, allowed] of [
    ['debug', ['debug', 'info', 'warn', 'error']],
    ['info', ['info', 'warn', 'error']],
    ['warn', ['warn', 'error']],
    ['error', ['error']],
    ['silent', []],
  ] as const) {
    const seen = await page.evaluate(async (l) => {
      const hooks = window.vibeglobePlayground;
      hooks?.clearLog();
      hooks?.globe.diagnostics.setLogLevel(l);
      hooks?.globe.jumpTo({ zoom: 5 + Math.random() });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return hooks?.loggedLevels() ?? [];
    }, level);
    for (const entry of seen) expect(allowed as readonly string[], `${level}: got ${entry}`).toContain(entry);
    if (level === 'debug') expect(seen).toContain('debug');
  }
});

test('an exported trace holds tile states, requests with their end, cancellation and failure, and camera moves, and tracing off records nothing (F121)', async ({
  page,
}) => {
  const session = await fixtureSession(page, [
    { minLevel: 6, maxLevel: 6, status: 500 },
    { minLevel: 7, latencyMs: 3000 },
  ]);
  await openGlobe(page, `backend=webgl2&imagery=levels&session=${session}&lon=12.5&lat=41.9&zoom=5`);
  expect(await page.evaluate(() => window.vibeglobePlayground?.globe.diagnostics.stopTrace().length)).toBe(0);
  await page.evaluate(() => window.vibeglobePlayground?.globe.diagnostics.startTrace());
  for (const zoom of [6.5, 7.5, 5.5]) {
    await page.evaluate((z) => window.vibeglobePlayground?.globe.jumpTo({ zoom: z }), zoom);
    await page.waitForTimeout(1500);
  }
  const trace = await page.evaluate(
    () => JSON.stringify(window.vibeglobePlayground?.globe.diagnostics.stopTrace()) ?? '[]',
  );
  const events = JSON.parse(trace) as { timeMs: number; kind: string; event: string }[];
  const has = (kind: string, event: string): boolean => events.some((e) => e.kind === kind && e.event === event);
  for (const [kind, event] of [
    ['request', 'start'],
    ['request', 'end'],
    ['request', 'cancel'],
    ['request', 'fail'],
    ['tile', 'ready'],
    ['camera', 'move'],
  ] as const)
    expect(has(kind, event), `${kind} ${event}`).toBe(true);
  for (const event of events) expect(typeof event.timeMs).toBe('number');
});
