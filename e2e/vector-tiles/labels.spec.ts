// F449: symbol layers place point labels and labels along lines with collision and priorities, never duplicated across
// tile edges, and without flicker while the camera pans, zooms, rotates and tilts.
import { expect, test, type Page } from '@playwright/test';
import { capture, openVector, settle } from './support.ts';

test.use({ viewport: { width: 640, height: 480 } });

interface Placed {
  id: number;
  layerId: string;
  text: string;
  boxes: { minX: number; minY: number; maxX: number; maxY: number }[];
  opacity: number;
}

const placed = (page: Page): Promise<Placed[]> =>
  page.evaluate(() => (window.vibeglobeVectorTiles?.layer?.placedLabels() ?? []) as unknown as Placed[]);

const overlaps = (a: Placed['boxes'][number], b: Placed['boxes'][number]) =>
  a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;

test('placed labels never overlap, and higher priorities win (F449)', async ({ page }) => {
  // Zoom 7 over Milan: Milan (rank 2) and Sesto San Giovanni (rank 6, symbol-sort-key) collide.
  await openVector(page, 'scenario=mvt-labels&backend=webgl2&zoom=7&lon=9.2&lat=45.5');
  const labels = await placed(page);
  expect(labels.length).toBeGreaterThan(3);
  for (const [i, a] of labels.entries())
    for (const b of labels.slice(i + 1))
      for (const ba of a.boxes) for (const bb of b.boxes) expect(overlaps(ba, bb), `${a.text} / ${b.text}`).toBe(false);
  const texts = labels.map((l) => l.text);
  expect(texts).toContain('Milan');
  expect(texts).not.toContain('Sesto San Giovanni');
});

test('road labels follow curved roads and are not duplicated across tile edges (F449)', async ({ page }) => {
  await openVector(page, 'scenario=mvt-labels&backend=webgl2&zoom=15&lon=9.19&lat=45.4778');
  const labels = await placed(page);
  const curved = labels.find((l) => l.text === 'Viale delle Rimembranze');
  expect(curved, labels.map((l) => l.text).join('|')).toBeDefined();
  // Glyph boxes along the arc: their direction turns.
  const centers = (curved?.boxes ?? []).map((b) => [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2] as const);
  const angles = centers
    .slice(1)
    .map((c, i) => Math.atan2(c[1] - (centers[i]?.[1] ?? 0), c[0] - (centers[i]?.[0] ?? 0)));
  expect(Math.max(...angles) - Math.min(...angles)).toBeGreaterThan(0.15);
  // No two labels of the same road within 120 px of each other (the label spacing is 250 px).
  for (const [i, a] of labels.entries())
    for (const b of labels.slice(i + 1)) {
      if (a.text !== b.text) continue;
      const ca = a.boxes[0];
      const cb = b.boxes[0];
      if (ca === undefined || cb === undefined) continue;
      expect(Math.hypot(ca.minX - cb.minX, ca.minY - cb.minY), a.text).toBeGreaterThan(120);
    }
});

/** Steps a camera path frame by frame and counts labels that disappear and reappear (flicker). */
async function flickers(page: Page, step: (k: number) => Record<string, number>, frames: number): Promise<number> {
  const history = new Map<number, boolean[]>();
  for (let k = 0; k < frames; k++) {
    await page.evaluate((v) => window.vibeglobePlayground?.globe.jumpTo(v), step(k));
    await capture(page);
    const shown = new Set((await placed(page)).filter((l) => l.opacity > 0).map((l) => l.id));
    for (const id of new Set([...history.keys(), ...shown])) {
      const list = history.get(id) ?? Array<boolean>(k).fill(false);
      list.push(shown.has(id));
      history.set(id, list);
    }
  }
  let count = 0;
  for (const list of history.values()) {
    // Shown, hidden, shown again within 10 frames: a flicker.
    for (let i = 1; i < list.length; i++) {
      if (list[i] || !list[i - 1]) continue;
      if (list.slice(i, i + 10).some(Boolean)) count++;
    }
  }
  return count;
}

test.describe('motion', () => {
  test.use({ viewport: { width: 400, height: 300 } });

  test('labels do not flicker during slow pan, zoom, rotate and tilt (F449)', async ({ page }) => {
    test.setTimeout(240_000);
    const start = { longitudeDeg: 9.19, latitudeDeg: 45.466, zoom: 15, headingDeg: 0, tiltDeg: 0 };
    await openVector(page, 'scenario=mvt-labels&backend=webgl2&zoom=15&lon=9.19&lat=45.466');
    await page.evaluate(() => window.vibeglobePlayground?.globe.setViewMode('3d'));
    await page.evaluate((v) => window.vibeglobePlayground?.globe.jumpTo(v), start);
    await settle(page);
    const paths: Record<string, (k: number) => Record<string, number>> = {
      pan: (k) => ({ ...start, longitudeDeg: start.longitudeDeg + k * 0.00005 }),
      zoom: (k) => ({ ...start, zoom: start.zoom + k * 0.01 }),
      rotate: (k) => ({ ...start, headingDeg: k * 0.5 }),
      tilt: (k) => ({ ...start, tiltDeg: k * 0.75 }),
    };
    for (const [name, path] of Object.entries(paths)) {
      expect(await flickers(page, path, 16), name).toBe(0);
      await page.evaluate((v) => window.vibeglobePlayground?.globe.jumpTo(v), start);
      await settle(page);
    }
  });
});
