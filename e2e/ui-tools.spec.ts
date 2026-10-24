// The ui package's tools on a live globe (M12): search with a geocoder (F426), view state in URLs and JSON (F414),
// bookmarks (F415), screenshots (F416) and the minimap (F417).
import { expect, test, type Locator, type Page } from '@playwright/test';
import { waitForIdle } from './support/globe.ts';
import { fixtureSession } from './support/imagery.ts';
import { openUi, touch } from './support/ui-layer.ts';

test.use({ viewport: { width: 640, height: 480 }, hasTouch: true });

async function tap(page: Page, locator: Locator): Promise<void> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('not visible');
  await touch(page, box.x + box.width / 2, box.y + box.height / 2);
}

/** Waits for the next movement started by the API to end, and returns where the camera is then. */
async function flightEnd(page: Page, action: () => Promise<void>): Promise<{ lon: number; lat: number; zoom: number }> {
  await page.evaluate(() => {
    const globe = window.vibeglobePlayground?.globe;
    const holder = window as unknown as { ended?: boolean; started?: boolean };
    holder.ended = false;
    holder.started = false;
    const stopStart = globe?.on('movestart', ({ cause }) => {
      if (cause === 'api') holder.started = true;
    });
    const stop = globe?.on('moveend', ({ cause }) => {
      if (cause !== 'api') return;
      holder.ended = true;
      stop?.();
      stopStart?.();
    });
  });
  await action();
  await page.waitForFunction(() => (window as unknown as { ended?: boolean }).ended === true);
  return page.evaluate(() => {
    const camera = window.vibeglobePlayground?.globe.camera;
    return { lon: camera?.longitudeDeg ?? NaN, lat: camera?.latitudeDeg ?? NaN, zoom: camera?.zoom ?? NaN };
  });
}

test.describe('the search box (F426)', () => {
  test('without a geocoder offers coordinates only; typed coordinates fly there', async ({ page }) => {
    await openUi(page, { query: 'backend=webgl2&zoom=2' });
    const input = page.locator('.vg-ui__search-input');
    await input.fill('Torino');
    await expect(page.locator('.vg-ui__search-status')).toHaveText('Type coordinates, for example 45.4642, 9.19');
    await expect(page.locator('.vg-ui__search-option')).toHaveCount(0);
    for (const [text, lon, lat] of [
      ['45.0703, 7.6869', 7.6869, 45.0703],
      ['45°04\'13"N 7°41\'13"E', 7.6869, 45.0703],
      ['32T 395180 4991430', 7.6685, 45.0686],
    ] as const) {
      await input.fill(text);
      const end = await flightEnd(page, () => input.press('Enter'));
      expect(end.lon).toBeCloseTo(lon, 2);
      expect(end.lat).toBeCloseTo(lat, 2);
    }
  });

  test('lists a mock geocoder’s results, chosen with arrows and Enter, a click or a tap, and flies there', async ({
    page,
  }) => {
    // Three flights: on a software GPU frames come about four a second, and the engine clock advances at most 100 ms
    // a frame, so each flight lasts about twice its duration.
    test.setTimeout(90_000);
    await openUi(page, { query: 'backend=webgl2&zoom=2' });
    await page.evaluate(() => {
      const handle = window.vibeglobeUi;
      if (handle === undefined) throw new Error('no ui');
      const places = [
        { label: 'Torino', longitudeDeg: 7.6869, latitudeDeg: 45.0703, zoom: 11 },
        { label: 'Toronto', longitudeDeg: -79.3832, latitudeDeg: 43.6532, zoom: 10 },
        { label: 'Tokyo', longitudeDeg: 139.6917, latitudeDeg: 35.6895, zoom: 9 },
      ];
      handle.layer.replace(
        new handle.ui.SearchControl({
          debounceMs: 50,
          geocoder: {
            search: async (query) => places.filter((p) => p.label.toLowerCase().startsWith(query.toLowerCase())),
          },
        }),
      );
    });
    const input = page.locator('.vg-ui__search-input');
    const options = page.locator('.vg-ui__search-option');
    await input.fill('to');
    await expect(options).toHaveText(['Torino', 'Toronto', 'Tokyo']);
    // Keyboard: down twice selects Tokyo; Enter flies there.
    await input.press('ArrowDown');
    await input.press('ArrowDown');
    await expect(input).toHaveAttribute('aria-activedescendant', /option-2$/);
    let end = await flightEnd(page, () => input.press('Enter'));
    expect(end).toMatchObject({ lon: expect.closeTo(139.6917, 6), zoom: expect.closeTo(9, 6) });
    // Mouse.
    await input.fill('tor');
    await expect(options).toHaveText(['Torino', 'Toronto']);
    end = await flightEnd(page, () => options.nth(1).click());
    expect(end.lon).toBeCloseTo(-79.3832, 6);
    // Touch.
    await input.fill('tori');
    await expect(options).toHaveText(['Torino']);
    end = await flightEnd(page, () => tap(page, options.first()));
    expect(end.lat).toBeCloseTo(45.0703, 6);
  });

  test('a failing or slow geocoder shows a translated message and never blocks the map', async ({ page }) => {
    await openUi(page, { query: 'backend=webgl2&zoom=2', language: 'it' });
    await page.evaluate(() => {
      const handle = window.vibeglobeUi;
      if (handle === undefined) throw new Error('no ui');
      handle.layer.replace(
        new handle.ui.SearchControl({
          debounceMs: 50,
          geocoder: {
            search: (query) =>
              query === 'slow' ? new Promise(() => undefined) : Promise.reject(new Error('service down')),
          },
        }),
      );
    });
    const input = page.locator('.vg-ui__search-input');
    const status = page.locator('.vg-ui__search-status');
    await input.fill('roma');
    await expect(status).toHaveText('La ricerca non è disponibile al momento');
    await input.fill('slow');
    await expect(status).toHaveText('Ricerca in corso…');
    // The map keeps drawing and moving while the query hangs.
    const before = await page.evaluate(() => window.vibeglobePlayground?.globe.frameNumber ?? 0);
    await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ zoom: 4 }));
    await waitForIdle(page);
    expect(await page.evaluate(() => window.vibeglobePlayground?.globe.frameNumber ?? 0)).toBeGreaterThan(before);
    expect(await page.evaluate(() => window.vibeglobePlayground?.globe.camera.zoom)).toBeCloseTo(4, 6);
  });
});

/** The camera fields a view restores, and the frame's pixels as a fingerprint. */
async function viewOf(page: Page): Promise<{ camera: Record<string, number | string>; pixels: number[] }> {
  return page.evaluate(async () => {
    const globe = window.vibeglobePlayground?.globe;
    if (globe === undefined) throw new Error('no globe');
    const c = globe.camera;
    const frame = await globe.captureFrame();
    // A coarse 16 x 12 grid of luminance: equal views give equal grids up to rounding.
    const pixels: number[] = [];
    for (let gy = 0; gy < 12; gy++)
      for (let gx = 0; gx < 16; gx++) {
        const x = Math.floor(((gx + 0.5) / 16) * frame.widthPx);
        const y = Math.floor(((gy + 0.5) / 12) * frame.heightPx);
        const i = (y * frame.widthPx + x) * 4;
        pixels.push((frame.rgba[i] ?? 0) + (frame.rgba[i + 1] ?? 0) + (frame.rgba[i + 2] ?? 0));
      }
    return {
      camera: {
        lon: c.longitudeDeg,
        lat: c.latitudeDeg,
        zoom: c.zoom,
        heading: c.headingDeg,
        tilt: c.tiltDeg,
        mode: c.viewMode,
        chosenTilt: c.chosenTiltDeg,
      },
      pixels,
    };
  });
}

test.describe('view state in URLs and JSON (F414)', () => {
  for (const [mode, setup] of [
    [
      'auto',
      (g: import('@vibeglobe/core').Globe) =>
        void g.jumpTo({ longitudeDeg: 7.66, latitudeDeg: 45.07, zoom: 9.3, headingDeg: 25 }),
    ],
    [
      '2d',
      (g: import('@vibeglobe/core').Globe) => (
        g.setViewMode('2d'),
        void g.jumpTo({ longitudeDeg: -3.7, latitudeDeg: 40.4, zoom: 7.1 })
      ),
    ],
    [
      'manual',
      (g: import('@vibeglobe/core').Globe) =>
        void g.jumpTo({ longitudeDeg: 151.2, latitudeDeg: -33.86, zoom: 11.7, headingDeg: 300, tiltDeg: 55 }),
    ],
  ] as const)
    test(`a ${mode} view restores exactly from its URL and its JSON in a new page`, async ({ page, browser }) => {
      await openUi(page, { query: 'backend=webgl2' });
      await page.evaluate(`(${setup.toString()})(window.vibeglobePlayground.globe)`);
      await waitForIdle(page);
      const original = await viewOf(page);
      const { url, json } = await page.evaluate(() => {
        const handle = window.vibeglobeUi;
        const globe = window.vibeglobePlayground?.globe;
        if (handle === undefined || globe === undefined) throw new Error('no ui');
        const view = handle.gis.viewStateOf(globe.camera);
        if (view === undefined) throw new Error('no view');
        return { url: handle.gis.viewStateToUrl(location.href, view), json: handle.gis.viewStateToJson(view) };
      });
      for (const [kind, restore] of [
        ['url', 'handle.gis.viewStateFromUrl(location.href)'],
        ['json', `handle.gis.viewStateFromJson(${JSON.stringify(json)})`],
      ] as const) {
        const other = await browser.newPage({ viewport: { width: 640, height: 480 } });
        await openUi(other, { query: `${new URL(url).search.slice(1)}${kind === 'url' ? new URL(url).hash : ''}` });
        await other.evaluate(`(() => {
          const handle = window.vibeglobeUi;
          const view = ${restore};
          if (view === undefined) throw new Error('no view in ${kind}');
          handle.ui.applyViewState(window.vibeglobePlayground.globe, view);
        })()`);
        await waitForIdle(other);
        const restored = await viewOf(other);
        for (const [key, value] of Object.entries(original.camera))
          if (typeof value === 'number') expect(restored.camera[key] as number, `${kind} ${key}`).toBeCloseTo(value, 6);
          else expect(restored.camera[key], `${kind} ${key}`).toBe(value);
        const differing = restored.pixels.filter((value, i) => Math.abs(value - (original.pixels[i] ?? 0)) > 6).length;
        expect(differing, `${kind} pixels`).toBeLessThanOrEqual(2);
        await other.close();
      }
    });

  test('malformed and out-of-range URLs neither crash nor move the view', async ({ page }) => {
    await openUi(page, { query: 'backend=webgl2' });
    const results = await page.evaluate(() => {
      const handle = window.vibeglobeUi;
      if (handle === undefined) throw new Error('no ui');
      return ['#view=abc', '#view=1/2/3', '#view=40/95/190/-30/120/3d', '#view=1/2/3/4/5/auto/NaN'].map((hash) => {
        const view = handle.gis.viewStateFromUrl(`https://example.org/${hash}`);
        return view === undefined
          ? 'rejected'
          : `${view.zoom}/${view.latitudeDeg}/${view.longitudeDeg}/${view.tiltDeg}`;
      });
    });
    expect(results).toEqual(['rejected', 'rejected', '28/90/-170/89', 'rejected']);
  });
});

test.describe('bookmarks (F415)', () => {
  test('save, list, open, remove, export and re-import, through the API and with mouse, touch and keyboard', async ({
    page,
  }) => {
    await openUi(page, { query: 'backend=webgl2&lon=7.66&lat=45.07&zoom=8' });
    await page.evaluate(() => {
      const handle = window.vibeglobeUi;
      if (handle === undefined) throw new Error('no ui');
      handle.layer.add(new handle.ui.BookmarksControl());
    });
    const bookmarks = (): Promise<{ name: string; lon: number }[]> =>
      page.evaluate(() => {
        const control = window.vibeglobeUi?.layer.get('bookmarks') as
          InstanceType<NonNullable<typeof window.vibeglobeUi>['ui']['BookmarksControl']> | undefined;
        return (control?.list() ?? []).map((b) => ({ name: b.name, lon: b.view.longitudeDeg }));
      });
    // API.
    await page.evaluate(() => {
      const control = window.vibeglobeUi?.layer.get('bookmarks') as
        InstanceType<NonNullable<typeof window.vibeglobeUi>['ui']['BookmarksControl']> | undefined;
      control?.add('Turin');
    });
    // Mouse: open the panel, name the view, save.
    const button = page.locator('.vg-ui__button--bookmarks');
    await button.click();
    await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: 2.35, latitudeDeg: 48.85 }));
    const name = page.locator('.vg-ui__bookmarks-panel .vg-ui__text-input');
    await name.fill('Paris');
    await page.locator('.vg-ui__button--bookmark-add').click();
    // Keyboard: type a name and press Enter.
    await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: -0.13, latitudeDeg: 51.5 }));
    await name.fill('London');
    await name.press('Enter');
    // Touch: save without a name.
    await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ longitudeDeg: 12.5, latitudeDeg: 41.9 }));
    await tap(page, page.locator('.vg-ui__button--bookmark-add'));
    expect((await bookmarks()).map((b) => b.name)).toEqual(['Turin', 'Paris', 'London', 'View 4']);
    await expect(page.locator('.vg-ui__button--bookmark-go')).toHaveText(['Turin', 'Paris', 'London', 'View 4']);
    // Open: a flight to the saved camera.
    const end = await flightEnd(page, () => page.getByRole('button', { name: 'Go to Paris' }).click());
    expect(end.lon).toBeCloseTo(2.35, 6);
    expect(end.lat).toBeCloseTo(48.85, 6);
    const exported = await page.evaluate(() => {
      const control = window.vibeglobeUi?.layer.get('bookmarks') as
        InstanceType<NonNullable<typeof window.vibeglobeUi>['ui']['BookmarksControl']> | undefined;
      return control?.exportJson() ?? '';
    });
    // Remove with the keyboard.
    await page.getByRole('button', { name: 'Remove London' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.vg-ui__button--bookmark-go')).toHaveText(['Turin', 'Paris', 'View 4']);
    // Re-import the export: identical.
    const reimported = await page.evaluate((json) => {
      const control = window.vibeglobeUi?.layer.get('bookmarks') as
        InstanceType<NonNullable<typeof window.vibeglobeUi>['ui']['BookmarksControl']> | undefined;
      return { ok: control?.importJson(json), again: control?.exportJson(), bad: control?.importJson('[{"id":1}]') };
    }, exported);
    expect(reimported).toEqual({ ok: true, again: exported, bad: false });
    await expect(page.locator('.vg-ui__button--bookmark-go')).toHaveText(['Turin', 'Paris', 'London', 'View 4']);
  });
});

test.describe('screenshot (F416)', () => {
  test('exports the view at the canvas size and at 2x, complete, with the credits drawn in', async ({ page }) => {
    await openUi(page, { query: 'backend=webgl2&lon=7.66&lat=45.07&zoom=3' });
    await page.evaluate(() => {
      const handle = window.vibeglobeUi;
      if (handle === undefined) throw new Error('no ui');
      handle.layer.add(new handle.ui.ScreenshotControl());
    });
    const sizes = await page.evaluate(async () => {
      const handle = window.vibeglobeUi;
      const globe = window.vibeglobePlayground?.globe;
      if (handle === undefined || globe === undefined) throw new Error('no ui');
      const frame = await globe.captureFrame();
      const results = [];
      for (const scale of [1, 2]) {
        const blob = await handle.ui.captureView(globe, { scale });
        const bitmap = await createImageBitmap(blob);
        results.push({ scale, width: bitmap.width, height: bitmap.height, type: blob.type });
      }
      return { canvas: [frame.widthPx, frame.heightPx], results };
    });
    for (const result of sizes.results) {
      expect(result.type).toBe('image/png');
      expect(result.width).toBe((sizes.canvas[0] ?? 0) * result.scale);
      expect(result.height).toBe((sizes.canvas[1] ?? 0) * result.scale);
    }
    // The download button saves a PNG.
    const download = page.waitForEvent('download');
    await page.locator('.vg-ui__button--screenshot').click();
    expect((await download).suggestedFilename()).toBe('vibeglobe.png');
  });
});

test.describe('screenshot larger than the canvas (F416)', () => {
  for (const backend of ['webgpu', 'webgl2'] as const)
    test(`exports the canvas size, 2x and 4096 × 4096, complete, matching the view, with the credits, on ${backend}`, async ({
      page,
    }) => {
      test.setTimeout(240_000);
      const session = await fixtureSession(page);
      await openUi(page, {
        query: `backend=${backend}&session=${session}&imagery=world&requiredCredit=fixture-world&lon=7.66&lat=45.07&zoom=5`,
      });
      await waitForIdle(page);
      const result = await page.evaluate(async () => {
        const handle = window.vibeglobeUi;
        const globe = window.vibeglobePlayground?.globe;
        if (handle === undefined || globe === undefined) throw new Error('no ui');
        const frame = await globe.captureFrame();
        const sizes = [];
        for (const scale of [1, 2]) {
          const bitmap = await createImageBitmap(await handle.ui.captureView(globe, { scale }));
          sizes.push([bitmap.width / frame.widthPx, bitmap.height / frame.heightPx]);
        }
        // The live view keeps drawing frames while the large image's tiles load.
        let frames = 0;
        const stop = globe.on('frame', () => frames++);
        const blob = await handle.ui.captureView(globe, { widthPx: 4096, heightPx: 4096 });
        stop();
        const bitmap = await createImageBitmap(blob);
        const full = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
        if (full === null) throw new Error('no 2d');
        full.drawImage(bitmap, 0, 0);
        const pixels = full.getImageData(0, 0, bitmap.width, bitmap.height).data;
        let empty = 0;
        let black = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if ((pixels[i + 3] ?? 0) < 255) empty++;
          else if ((pixels[i] ?? 0) + (pixels[i + 1] ?? 0) + (pixels[i + 2] ?? 0) < 24) black++;
        }
        // The credits strip in the bottom-right corner: light, with dark text and the required logo.
        const strip = full.getImageData(bitmap.width - 1200, bitmap.height - 120, 1200, 120).data;
        let dark = 0;
        for (let i = 0; i < strip.length; i += 4) if ((strip[i] ?? 0) < 100) dark++;
        const corner = Array.from(full.getImageData(bitmap.width - 3, bitmap.height - 3, 1, 1).data);
        return {
          sizes,
          width: bitmap.width,
          height: bitmap.height,
          empty,
          black,
          dark,
          corner,
          frames,
          credits: globe.credits().map((credit) => [credit.text, credit.logo !== undefined]),
        };
      });
      console.log(`[F416] ${backend}: ${JSON.stringify({ ...result, corner: result.corner.join(',') })}`);
      expect(result.sizes).toEqual([
        [1, 1],
        [2, 2],
      ]);
      expect([result.width, result.height]).toEqual([4096, 4096]);
      expect(result.empty).toBe(0);
      expect(result.black).toBe(0);
      expect(result.credits).toContainEqual(['Required world', true]);
      expect(Math.min(...result.corner.slice(0, 3))).toBeGreaterThan(200);
      expect(result.dark).toBeGreaterThan(200);
      expect(result.frames).toBeGreaterThanOrEqual(3);
      // The image shows the view: on the base imagery, the same at every resolution (the fixture tiles draw their own
      // borders, denser at finer levels), the canvas frame and the image reduced to 64 × 64 line up, no shift better.
      await openUi(page, { query: `backend=${backend}&lon=12.5&lat=42&zoom=4` });
      await waitForIdle(page);
      const match = await page.evaluate(async () => {
        const globe = window.vibeglobePlayground?.globe;
        if (globe === undefined) throw new Error('no globe');
        const reduce = (frame: { widthPx: number; heightPx: number; rgba: Uint8ClampedArray }): Uint8ClampedArray => {
          const full = new OffscreenCanvas(frame.widthPx, frame.heightPx);
          full.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(frame.rgba), frame.widthPx), 0, 0);
          const side = Math.min(frame.widthPx, frame.heightPx);
          const small = new OffscreenCanvas(64, 64).getContext('2d');
          if (small === null) throw new Error('no 2d');
          small.drawImage(full, (frame.widthPx - side) / 2, (frame.heightPx - side) / 2, side, side, 0, 0, 64, 64);
          return small.getImageData(0, 0, 64, 64).data;
        };
        const theirs = reduce(await globe.captureFrame());
        const ours = reduce(await globe.captureView({ widthPx: 1600, heightPx: 1600 }));
        const difference = (dx: number, dy: number): number => {
          let sum = 0;
          let counted = 0;
          for (let y = 2; y < 62; y++)
            for (let x = 2; x < 62; x++)
              for (let c = 0; c < 3; c++) {
                sum += Math.abs((ours[((y + dy) * 64 + x + dx) * 4 + c] ?? 0) - (theirs[(y * 64 + x) * 4 + c] ?? 0));
                counted++;
              }
          return sum / counted;
        };
        let bestShifted = Number.POSITIVE_INFINITY;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++)
            if (dx !== 0 || dy !== 0) bestShifted = Math.min(bestShifted, difference(dx, dy));
        return { difference: difference(0, 0), bestShifted };
      });
      console.log(`[F416] ${backend} view match: ${JSON.stringify(match)}`);
      expect(match.difference).toBeLessThan(6);
      expect(match.difference).toBeLessThan(match.bestShifted);
    });
});

test.describe('the minimap (F417)', () => {
  test('is absent unless enabled', async ({ page }) => {
    await openUi(page, { query: 'backend=webgl2', defaults: 'all' });
    await expect(page.locator('.vg-ui__minimap')).toHaveCount(0);
  });

  test('shows the main view’s footprint, a trapezoid when tilted, within its per-frame cost', async ({ page }) => {
    await openUi(page, { query: 'backend=webgl2&lon=7.66&lat=45.07&zoom=7' });
    await page.evaluate(() => {
      const handle = window.vibeglobeUi;
      if (handle === undefined) throw new Error('no ui');
      handle.layer.add(new handle.ui.MinimapControl({ imageUrl: '/imagery/natural-earth-4096.jpg' }));
    });
    const footprint = async (): Promise<{ corners: number[][]; expected: number[][]; costMs: number }> =>
      page.evaluate(() => {
        const handle = window.vibeglobeUi;
        const globe = window.vibeglobePlayground?.globe;
        const app = document.getElementById('app');
        if (handle === undefined || globe === undefined || app === null) throw new Error('no ui');
        const control = handle.layer.get('minimap') as InstanceType<typeof handle.ui.MinimapControl>;
        let costMs = 0;
        for (let i = 0; i < 10; i++) {
          control.update();
          costMs = Math.max(costMs, control.lastUpdateMs);
        }
        const points = control.footprint;
        // Corners are the first sample of each edge (8 per edge).
        const corners = [0, 8, 16, 24].map((i) => [points[i]?.longitudeDeg ?? NaN, points[i]?.latitudeDeg ?? NaN]);
        const w = app.clientWidth;
        const h = app.clientHeight;
        const expected = [
          [0, 0],
          [w, 0],
          [w, h],
          [0, h],
        ].map(([x, y]) => {
          const p = globe.screenToGeo({ xPx: x ?? 0, yPx: y ?? 0 });
          return [p?.longitudeDeg ?? NaN, p?.latitudeDeg ?? NaN];
        });
        return { corners, expected, costMs };
      });
    // 2D: a rectangle on the ground.
    await page.evaluate(() => window.vibeglobePlayground?.globe.setViewMode('2d'));
    await waitForIdle(page);
    const flat = await footprint();
    expect(flat.corners).toEqual(flat.expected);
    expect(flat.costMs).toBeLessThan(2);
    // Tilted 3D: the far edge is wider than the near one (a trapezoid).
    await page.evaluate(() => window.vibeglobePlayground?.globe.jumpTo({ zoom: 9, tiltDeg: 55 }));
    await waitForIdle(page);
    const tilted = await footprint();
    expect(tilted.corners).toEqual(tilted.expected);
    const width = (a: number[] | undefined, b: number[] | undefined): number => Math.abs((a?.[0] ?? 0) - (b?.[0] ?? 0));
    expect(width(tilted.corners[0], tilted.corners[1])).toBeGreaterThan(
      width(tilted.corners[3], tilted.corners[2]) * 1.2,
    );
    expect(tilted.costMs).toBeLessThan(2);
    // Globe phase: the whole visible cap, bounded by the horizon around the point below the eye.
    await page.evaluate(() => {
      const globe = window.vibeglobePlayground?.globe;
      globe?.setViewMode('auto');
      globe?.jumpTo({ zoom: 1.5 });
    });
    await waitForIdle(page);
    const cap = await page.evaluate(() => {
      const handle = window.vibeglobeUi;
      const globe = window.vibeglobePlayground?.globe;
      if (handle === undefined || globe === undefined) throw new Error('no ui');
      const control = handle.layer.get('minimap') as InstanceType<typeof handle.ui.MinimapControl>;
      control.update();
      const eye = { longitudeDeg: globe.camera.eyeLongitudeDeg, latitudeDeg: globe.camera.eyeLatitudeDeg };
      const r = 6378137;
      const horizon = r * Math.acos(r / (r + globe.camera.altitudeMeters));
      return control.footprint.map((p) => handle.gis.measureDistance(eye, p).distanceMeters / horizon);
    });
    expect(cap.length).toBe(48);
    for (const ratio of cap) expect(ratio).toBeCloseTo(1, 2);
    // The minimap canvas shows the outline's red.
    const red = await page.locator('.vg-ui__minimap-canvas').evaluate((canvas: HTMLCanvasElement) => {
      const data = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data ?? [];
      let count = 0;
      for (let i = 0; i < data.length; i += 4) if ((data[i] ?? 0) > 200 && (data[i + 1] ?? 0) < 100) count += 1;
      return count;
    });
    expect(red).toBeGreaterThan(0);
  });
});
