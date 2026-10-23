// The ui package's coordinates readout, drawing and measurement tools on a live globe with terrain (M12, F406–F411):
// mouse, touch and keyboard.
import { expect, test, type Page } from '@playwright/test';
import { waitForIdle } from './support/globe.ts';
import { waitForStreaming } from './support/imagery.ts';
import { openUi, touch } from './support/ui-layer.ts';

test.use({ viewport: { width: 640, height: 480 }, hasTouch: true });

/** The fixture mountain (terrarium terrain, a 4,000 m peak at 6.86°E, 45.83°N), seen from above. */
const MOUNTAIN = 'backend=webgl2&terrain=terrarium&lon=6.86&lat=45.83&zoom=10&viewMode=2d';

type Coordinates = number[] | number[][] | number[][][];

/** Opens the playground with terrain, the UI and a drawing (or measurement) control. */
async function openDrawing(page: Page, control: 'DrawControl' | 'MeasureControl' = 'DrawControl'): Promise<void> {
  await openUi(page, { query: MOUNTAIN, defaults: false });
  await page.evaluate((name) => {
    const handle = window.vibeglobeUi;
    if (handle === undefined) throw new Error('no ui');
    const added = new handle.ui[name]();
    handle.layer.add(added);
    const tool = added.tool;
    const events: string[] = [];
    (window as unknown as { drawEvents: string[] }).drawEvents = events;
    for (const name of ['create', 'change', 'delete', 'validation'] as const) tool.on(name, () => events.push(name));
  }, control);
  await waitForStreaming(page);
  // The layers attach after the globe is ready and the layers package loaded.
  await page.waitForFunction(() => window.vibeglobePlayground?.globe.layerTarget() !== undefined);
  await page.waitForTimeout(200);
}

/** The drawn shapes as GeoJSON geometries. */
async function shapes(page: Page, id = 'draw'): Promise<{ type: string; coordinates: Coordinates }[]> {
  return page.evaluate((controlId) => {
    const control = window.vibeglobeUi?.layer.get(controlId) as unknown as {
      tool: { features(): { geometry: unknown }[] };
    };
    return control.tool.features().map((f) => f.geometry as { type: string; coordinates: Coordinates });
  }, id);
}

async function events(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { drawEvents: string[] }).drawEvents);
}

/** The position the frame shows at a screen point. */
async function geoAt(page: Page, x: number, y: number): Promise<[number, number]> {
  return page.evaluate(
    ([xPx, yPx]) => {
      const p = window.vibeglobePlayground?.globe.screenToGeo({ xPx, yPx });
      if (p === undefined) throw new Error('off the globe');
      return [p.longitudeDeg, p.latitudeDeg] as [number, number];
    },
    [x, y] as const,
  );
}

async function camera(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const c = window.vibeglobePlayground?.globe.camera;
    return [c?.longitudeDeg ?? NaN, c?.latitudeDeg ?? NaN, c?.zoom ?? NaN];
  });
}

/** Whether the drawn frame shows the shapes' red where a ground position is drawn (on its terrain height). */
async function redOnGround(page: Page, lon: number, lat: number): Promise<boolean> {
  return page.evaluate(
    async ([longitudeDeg, latitudeDeg]) => {
      const globe = window.vibeglobePlayground?.globe;
      if (globe === undefined) throw new Error('no globe');
      const height = globe.elevationAt({ longitudeDeg, latitudeDeg }).heightMeters;
      const point = globe.geoToScreen({ longitudeDeg, latitudeDeg, heightMeters: height });
      const frame = await globe.captureFrame();
      if (point === undefined) return false;
      const scale = frame.widthPx / (document.getElementById('app')?.clientWidth ?? frame.widthPx);
      // The nearest red pixel within 2 px of the point.
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const x = Math.round(point.xPx * scale) + dx;
          const y = Math.round(point.yPx * scale) + dy;
          const i = (y * frame.widthPx + x) * 4;
          const [r, g, b] = [frame.rgba[i] ?? 0, frame.rgba[i + 1] ?? 0, frame.rgba[i + 2] ?? 0];
          if (r > 150 && r > g + 60 && r > b + 60) return true;
        }
      return false;
    },
    [lon, lat] as const,
  );
}

const closeTo = (actual: number[] | undefined, expected: number[], digits = 9): void => {
  expect(actual?.[0]).toBeCloseTo(expected[0] ?? NaN, digits);
  expect(actual?.[1]).toBeCloseTo(expected[1] ?? NaN, digits);
};

test.describe('the coordinates readout (F406)', () => {
  test('shows the position and terrain elevation under the mouse and a touch, live and within budget', async ({
    page,
  }) => {
    await openUi(page, { query: MOUNTAIN });
    await waitForStreaming(page);
    const readout = page.locator('.vg-ui__readout-text');
    for (const [x, y] of [
      [320, 240],
      [200, 150],
      [450, 330],
    ] as const) {
      await page.mouse.move(x, y);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const expected = await page.evaluate(
        ([xPx, yPx]) => {
          const handle = window.vibeglobeUi;
          const globe = window.vibeglobePlayground?.globe;
          const p = globe?.screenToGeo({ xPx, yPx });
          if (handle === undefined || globe === undefined || p === undefined) throw new Error('no position');
          return {
            text: handle.gis.formatCoordinate(p, 'decimal'),
            elevation: Math.round(globe.elevationAt(p).heightMeters),
          };
        },
        [x, y] as const,
      );
      await expect(readout).toContainText(expected.text ?? 'none');
      const shown = Number(((await readout.textContent()) ?? '').match(/Elevation ([\d,]+) m/)?.[1]?.replace(/,/g, ''));
      // The picked height and the resident terrain's interpolation agree within the documented tolerance (5 m).
      expect(Math.abs(shown - expected.elevation)).toBeLessThanOrEqual(5);
      expect(expected.elevation).toBeGreaterThan(100);
    }
    // Touch: a tap and a long press show the touched point.
    for (const holdMs of [0, 600]) {
      await touch(page, 260, 200, 0, holdMs);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const text = await page.evaluate(() => {
        const handle = window.vibeglobeUi;
        const p = window.vibeglobePlayground?.globe.screenToGeo({ xPx: 260, yPx: 200 });
        return p === undefined ? '' : (handle?.gis.formatCoordinate(p, 'decimal') ?? '');
      });
      await expect(readout).toContainText(text);
      await expect(readout).toContainText('Under the pointer');
    }
    // The cost of one update stays within its budget (1 ms; measured over 50 updates).
    const costMs = await page.evaluate(() => {
      const control = window.vibeglobeUi?.layer.get('readout') as unknown as { localize(): void };
      const started = performance.now();
      for (let i = 0; i < 50; i++) control.localize();
      return (performance.now() - started) / 50;
    });
    expect(costMs).toBeLessThan(1);
  });

  test('switches format with the keyboard and reports the view center while navigating by keyboard', async ({
    page,
  }) => {
    await openUi(page, { query: MOUNTAIN });
    await waitForStreaming(page);
    const format = page.locator('.vg-ui__button--readout-format');
    const readout = page.locator('.vg-ui__readout-text');
    for (const [name, pattern] of [
      ['dms', /°.*′.*″/],
      ['utm', /^32T \d+ \d+/],
      ['decimal', /^\d+\.\d+°? ?[NS]?,? /],
    ] as const) {
      await format.focus();
      await page.keyboard.press('Enter');
      expect(
        await page.evaluate(() => (window.vibeglobeUi?.layer.get('readout') as unknown as { format: string }).format),
      ).toBe(name);
      // Keyboard navigation of the map: the readout follows the view center.
      await page.locator('#globe').focus();
      await page.keyboard.press('ArrowRight');
      await waitForIdle(page);
      await expect(readout).toContainText('View center');
      const center = await page.evaluate((formatName) => {
        const handle = window.vibeglobeUi;
        const c = window.vibeglobePlayground?.globe.camera;
        if (handle === undefined || c === undefined) throw new Error('no ui');
        return handle.gis.formatCoordinate(c, formatName as 'decimal' | 'dms' | 'utm');
      }, name);
      await expect(page.locator('.vg-ui__readout-coordinates')).toHaveText(center ?? '');
      await expect(page.locator('.vg-ui__readout-coordinates')).toHaveText(pattern);
    }
  });
});

test.describe('drawing points (F407)', () => {
  test('places ground-clamped points with mouse, touch and keyboard, never moving the map', async ({ page }) => {
    await openDrawing(page);
    await page.locator('.vg-ui__button--draw-point').click();
    const start = await camera(page);
    const expected = [await geoAt(page, 200, 160), await geoAt(page, 420, 300)];
    await page.mouse.click(200, 160);
    await touch(page, 420, 300);
    // Keyboard: the button activated by Enter hands the focus to the cursor; arrows move it, Enter places.
    await page.locator('.vg-ui__button--draw-point').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expect(page.locator('.vg-ui__draw-cursor')).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    expected.push(await geoAt(page, 320, 240), await geoAt(page, 328, 248));
    // A quick double click places two points and does not zoom.
    expected.push(await geoAt(page, 250, 330), await geoAt(page, 250, 330));
    await page.mouse.dblclick(250, 330);
    await waitForIdle(page);
    const drawn = await shapes(page);
    expect(drawn.map((s) => s.type)).toEqual(Array(6).fill('Point'));
    for (const [i, position] of expected.entries()) closeTo(drawn[i]?.coordinates as number[], position, 6);
    expect(await events(page)).toEqual(Array(6).fill('create'));
    expect(await camera(page)).toEqual(start);
    for (const position of expected.slice(0, 2)) expect(await redOnGround(page, position[0], position[1])).toBe(true);
  });
});

test.describe('drawing lines (F408)', () => {
  test('draws draped lines with mouse, touch and keyboard, with a preview that follows the pointer', async ({
    page,
  }) => {
    await openDrawing(page);
    await page.locator('.vg-ui__button--draw-line').click();
    // Mouse: two clicks, a move (the preview follows), and a double click that adds the last vertex and finishes.
    await page.mouse.click(150, 150);
    await page.mouse.click(300, 200);
    await page.mouse.move(400, 260);
    const draft = await page.evaluate(() => {
      const control = window.vibeglobeUi?.layer.get('draw') as unknown as { tool: { draft: unknown[] } };
      return control.tool.draft.length;
    });
    expect(draft).toBe(2);
    await page.waitForTimeout(100);
    await waitForIdle(page);
    const previewMid = await geoAt(page, 350, 230);
    expect(await redOnGround(page, previewMid[0], previewMid[1])).toBe(true);
    await page.mouse.dblclick(400, 260);
    // Touch: taps, and a double tap.
    await touch(page, 100, 400);
    await touch(page, 250, 420);
    await touch(page, 250, 420);
    // Keyboard: Enter places, arrows move, Enter on the last vertex again finishes.
    await page.locator('.vg-ui__button--draw-line').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    const drawn = await shapes(page);
    expect(drawn.map((s) => [s.type, (s.coordinates as number[][]).length])).toEqual([
      ['LineString', 3],
      ['LineString', 2],
      ['LineString', 2],
    ]);
    closeTo((drawn[0]?.coordinates as number[][])[0], await geoAt(page, 150, 150), 6);
    closeTo((drawn[2]?.coordinates as number[][])[1], await geoAt(page, 120, 240), 6);
    expect(await events(page)).toEqual(['create', 'create', 'create']);
    // Draped: the middle of a segment is drawn on the terrain.
    await waitForIdle(page);
    const middle = await geoAt(page, 225, 175);
    expect(await redOnGround(page, middle[0], middle[1])).toBe(true);
  });
});

test.describe('drawing polygons (F409)', () => {
  test('draws draped polygons with mouse, touch and keyboard, and reports self-intersection', async ({ page }) => {
    await openDrawing(page);
    await page.locator('.vg-ui__button--draw-polygon').click();
    // Mouse: closed by a click on the first vertex.
    for (const [x, y] of [
      [150, 120],
      [300, 120],
      [300, 260],
      [150, 260],
      [151, 121],
    ] as const)
      await page.mouse.click(x, y);
    // Touch: finished with the finish button.
    for (const [x, y] of [
      [380, 300],
      [500, 300],
      [440, 400],
    ] as const)
      await touch(page, x, y);
    await page.locator('.vg-ui__button--draw-finish').click();
    // Keyboard: a triangle closed by Enter on its first vertex.
    await page.locator('.vg-ui__button--draw-polygon').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Shift+ArrowUp');
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('Enter');
    let drawn = await shapes(page);
    expect(drawn.map((s) => [s.type, (s.coordinates as number[][][])[0]?.length])).toEqual([
      ['Polygon', 5],
      ['Polygon', 4],
      ['Polygon', 4],
    ]);
    expect(await events(page)).toEqual(['create', 'create', 'create']);
    // A bow tie is refused with a validation event and a message.
    await page.mouse.click(100, 380);
    await page.mouse.click(200, 460);
    await page.mouse.click(200, 380);
    await page.mouse.click(100, 460);
    await page.locator('.vg-ui__button--draw-finish').click();
    expect((await events(page)).at(-1)).toBe('validation');
    await expect(page.locator('.vg-ui__draw .vg-ui__status')).toHaveText('The polygon crosses itself');
    drawn = await shapes(page);
    expect(drawn).toHaveLength(3);
    // Draped: the inside of the first polygon is filled on the terrain.
    await page.locator('.vg-ui__button--draw-cancel').click();
    await waitForIdle(page);
    const inside = await geoAt(page, 225, 190);
    expect(await redOnGround(page, inside[0], inside[1])).toBe(true);
  });
});

test.describe('editing shapes (F410)', () => {
  test('moves, inserts and deletes vertices and moves shapes with mouse, touch and keyboard', async ({ page }) => {
    await openDrawing(page);
    await page.evaluate(() => {
      const control = window.vibeglobeUi?.layer.get('draw') as unknown as {
        tool: { setMode(m: string): void; place(p: [number, number]): void; finish(): boolean };
      };
      const globe = window.vibeglobePlayground?.globe;
      const at = (x: number, y: number): [number, number] => {
        const p = globe?.screenToGeo({ xPx: x, yPx: y });
        return [p?.longitudeDeg ?? 0, p?.latitudeDeg ?? 0];
      };
      control.tool.setMode('line');
      for (const [x, y] of [
        [150, 150],
        [300, 150],
        [300, 300],
      ])
        control.tool.place(at(x ?? 0, y ?? 0));
      control.tool.finish();
    });
    await page.locator('.vg-ui__button--draw-edit').click();
    const start = await camera(page);
    // Mouse: select by clicking the line, drag a vertex, drag a midpoint (inserts), and move the whole shape.
    await page.mouse.click(225, 150);
    await page.mouse.move(300, 150);
    await page.mouse.down();
    await page.mouse.move(340, 120, { steps: 4 });
    await page.mouse.up();
    let line = (await shapes(page))[0]?.coordinates as number[][];
    closeTo(line[1], await geoAt(page, 340, 120), 6);
    const midpoint = await page.evaluate(() => {
      const globe = window.vibeglobePlayground?.globe;
      const control = window.vibeglobeUi?.layer.get('draw') as unknown as {
        tool: { handles(): { kind: string; position: [number, number] }[] };
      };
      const handle = control.tool.handles().find((h) => h.kind === 'midpoint');
      return handle && globe?.geoToScreen({ longitudeDeg: handle.position[0], latitudeDeg: handle.position[1] });
    });
    if (midpoint === undefined) throw new Error('no midpoint');
    await page.mouse.move(midpoint.xPx, midpoint.yPx);
    await page.mouse.down();
    await page.mouse.move(midpoint.xPx, midpoint.yPx + 40, { steps: 4 });
    await page.mouse.up();
    expect((await shapes(page))[0]?.coordinates).toHaveLength(4);
    // Delete the selected (inserted) vertex with the toolbar.
    await page.locator('.vg-ui__button--draw-delete').click();
    expect((await shapes(page))[0]?.coordinates).toHaveLength(3);
    const before = (await shapes(page))[0]?.coordinates as number[][];
    // A point a quarter of the way along the second segment (away from its midpoint handle) grabs the whole line.
    const onLine = await page.evaluate((coordinates) => {
      const globe = window.vibeglobePlayground?.globe;
      const [a, b] = [coordinates[1], coordinates[2]].map((p) =>
        globe?.geoToScreen({ longitudeDeg: p?.[0] ?? 0, latitudeDeg: p?.[1] ?? 0 }),
      );
      if (a === undefined || b === undefined) throw new Error('off screen');
      return { x: a.xPx + (b.xPx - a.xPx) / 4, y: a.yPx + (b.yPx - a.yPx) / 4 };
    }, before);
    await page.mouse.move(onLine.x, onLine.y);
    await page.mouse.down();
    await page.mouse.move(onLine.x + 30, onLine.y, { steps: 4 });
    await page.mouse.up();
    line = (await shapes(page))[0]?.coordinates as number[][];
    expect((line[2]?.[0] ?? 0) - (before[2]?.[0] ?? 0)).toBeGreaterThan(0);
    expect(await camera(page)).toEqual(start);
    // Touch: drag the first vertex sideways.
    const first = await page.evaluate(() => {
      const globe = window.vibeglobePlayground?.globe;
      const control = window.vibeglobeUi?.layer.get('draw') as unknown as {
        tool: { features(): { geometry: { coordinates: number[][] } }[] };
      };
      const p = control.tool.features()[0]?.geometry.coordinates[0];
      return globe?.geoToScreen({ longitudeDeg: p?.[0] ?? 0, latitudeDeg: p?.[1] ?? 0 });
    });
    if (first === undefined) throw new Error('no vertex');
    await touch(page, first.xPx, first.yPx, 50);
    line = (await shapes(page))[0]?.coordinates as number[][];
    closeTo(line[0], await geoAt(page, first.xPx + 50, first.yPx), 4);
    // Keyboard: put the cursor on the last vertex, pick it with Enter, move it with arrows, delete it.
    const last = await page.evaluate(() => {
      const globe = window.vibeglobePlayground?.globe;
      const control = window.vibeglobeUi?.layer.get('draw') as unknown as {
        tool: { features(): { geometry: { coordinates: number[][] } }[] };
      };
      const p = control.tool.features()[0]?.geometry.coordinates.at(-1);
      return globe?.geoToScreen({ longitudeDeg: p?.[0] ?? 0, latitudeDeg: p?.[1] ?? 0 });
    });
    if (last === undefined) throw new Error('no vertex');
    await page.locator('.vg-ui__button--draw-edit').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.locator('.vg-ui__draw-cursor').focus();
    const cursorSteps = { x: Math.round((last.xPx - 320) / 8), y: Math.round((last.yPx - 240) / 8) };
    for (let i = 0; i < Math.abs(cursorSteps.x); i++)
      await page.keyboard.press(cursorSteps.x > 0 ? 'ArrowRight' : 'ArrowLeft');
    for (let i = 0; i < Math.abs(cursorSteps.y); i++)
      await page.keyboard.press(cursorSteps.y > 0 ? 'ArrowDown' : 'ArrowUp');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowLeft');
    line = (await shapes(page))[0]?.coordinates as number[][];
    // The vertex is now where the cursor is.
    const cursor = await page
      .locator('.vg-ui__draw-cursor')
      .evaluate((element: HTMLElement) => [
        Number.parseFloat(element.style.left),
        Number.parseFloat(element.style.top),
      ]);
    closeTo(line[2], await geoAt(page, cursor[0] ?? 0, cursor[1] ?? 0), 6);
    await page.keyboard.press('Delete');
    expect((await shapes(page))[0]?.coordinates).toHaveLength(2);
    const changes = (await events(page)).filter((e) => e === 'change').length;
    expect(changes).toBeGreaterThanOrEqual(6);
    // Still draped after the edits.
    await waitForIdle(page);
    line = (await shapes(page))[0]?.coordinates as number[][];
    const mid = [((line[0]?.[0] ?? 0) + (line[1]?.[0] ?? 0)) / 2, ((line[0]?.[1] ?? 0) + (line[1]?.[1] ?? 0)) / 2];
    expect(await redOnGround(page, mid[0] ?? 0, mid[1] ?? 0)).toBe(true);
  });
});

test.describe('measurement (F411)', () => {
  test('measures distance, path, area and bearing live with mouse, touch and keyboard, in English and Italian', async ({
    page,
  }) => {
    await openDrawing(page, 'MeasureControl');
    const readout = page.locator('.vg-ui__measure-readout');
    const expected = (): Promise<string[]> =>
      page.evaluate(() => {
        const handle = window.vibeglobeUi;
        const control = handle?.layer.get('measure') as unknown as {
          measurement: { kind: string; lengthMeters: number; areaSquareMeters: number; bearingDeg?: number };
          tool: {
            features(): { geometry: { type: string; coordinates: number[][] | number[][][] } }[];
            draft: number[][];
          };
        };
        const m = control.measurement;
        return m.kind === 'polygon'
          ? [
              `Area ${handle?.gis.formatArea(m.areaSquareMeters)}`,
              `Perimeter ${handle?.gis.formatLength(m.lengthMeters)}`,
            ]
          : [
              `Length ${handle?.gis.formatLength(m.lengthMeters)}`,
              `Bearing ${(m.bearingDeg ?? 0).toFixed(1).replace(/\.0$/, '')}°`,
            ];
      });
    // Mouse: a distance, live while drawing.
    await page.locator('.vg-ui__button--draw-line').click();
    await page.mouse.click(150, 240);
    await page.mouse.move(450, 240);
    await expect(readout).toContainText('Length');
    await expect(readout).toContainText('Bearing');
    const live = await page.evaluate(() => {
      const handle = window.vibeglobeUi;
      const globe = window.vibeglobePlayground?.globe;
      const a = globe?.screenToGeo({ xPx: 150, yPx: 240 });
      const b = globe?.screenToGeo({ xPx: 450, yPx: 240 });
      if (handle === undefined || a === undefined || b === undefined) throw new Error('no position');
      return handle.gis.formatLength(handle.gis.measureDistance(a, b).distanceMeters);
    });
    await expect(readout).toContainText(`Length ${live}`);
    await page.mouse.dblclick(450, 240);
    expect(await readout.locator('div').allTextContents()).toEqual(await expected());
    // Touch: an area.
    await page.locator('.vg-ui__button--draw-polygon').click();
    for (const [x, y] of [
      [200, 150],
      [400, 150],
      [400, 350],
    ] as const)
      await touch(page, x, y);
    await touch(page, 200, 350);
    await touch(page, 200, 350);
    expect(await readout.locator('div').allTextContents()).toEqual(await expected());
    await expect(readout).toContainText('km²');
    // Keyboard: a short distance, in meters, updated while editing.
    await page.locator('.vg-ui__button--draw-line').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expect(readout.locator('div').first()).toHaveText(/^Length \d+ m$/);
    expect(await readout.locator('div').allTextContents()).toEqual(await expected());
    // Italian.
    await page.evaluate(() => window.vibeglobeUi?.layer.setLanguage('it'));
    await expect(readout).toContainText('Lunghezza');
    await expect(readout).toContainText('Direzione');
  });
});
