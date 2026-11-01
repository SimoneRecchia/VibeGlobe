import { describe, expect, it, vi } from 'vitest';
import { Camera } from '../camera/camera.js';
import { groundZoomFromMercatorZoom, rangeForGroundZoom } from '../camera/zoom.js';
import { currentView } from './camera-state.js';
import { createGlobe } from './create-globe.js';
import { Movements, type MovementHost } from './movements.js';
import { fakeRenderer } from './test-renderer.js';
import type { Globe, ViewInit } from './types.js';

async function started(view: ViewInit): Promise<{ globe: Globe; ticks: (count: number) => void }> {
  const { renderer, factory } = fakeRenderer();
  const globe = createGlobe({ container: {}, renderer: factory, baseImageryUrl: 'w', view });
  await Promise.resolve();
  await Promise.resolve();
  renderer.flush();
  await globe.ready;
  // Display ticks of 16 ms that draw the frames the engine requested.
  const ticks = (count: number): void => {
    for (let i = 0; i < count; i++) {
      renderer.timers.advance(16);
      renderer.flush();
    }
  };
  return { globe, ticks };
}

describe('camera movements (F195–F201, ADR 0036)', () => {
  it('flies and eases to the exact target, settling as completed with movestart, move and moveend', async () => {
    const { globe, ticks } = await started({ longitudeDeg: 9.19, latitudeDeg: 45.46, zoom: 15 });
    const events: string[] = [];
    globe.on('movestart', ({ cause }) => events.push(`start:${cause}`));
    globe.on('moveend', ({ cause, outcome }) => events.push(`end:${cause}:${outcome}`));
    let moves = 0;
    globe.on('move', () => moves++);
    const flight = globe.flyTo({ longitudeDeg: 139.69, latitudeDeg: 35.68, zoom: 15, headingDeg: 20 });
    ticks(600);
    expect(await flight).toBe('completed');
    expect(globe.camera.longitudeDeg).toBeCloseTo(139.69, 9);
    expect(globe.camera.latitudeDeg).toBeCloseTo(35.68, 9);
    expect(globe.camera.zoom).toBeCloseTo(15, 6);
    expect(globe.camera.headingDeg).toBeCloseTo(20, 9);
    expect(events).toEqual(['start:api', 'end:api:completed']);
    expect(moves).toBeGreaterThan(10);
    const ease = globe.easeTo({ zoom: 14 }, { durationMs: 300 });
    ticks(40);
    expect(await ease).toBe('completed');
    expect(globe.camera.zoom).toBeCloseTo(14, 6);
    globe.destroy();
  });

  it('settles as interrupted by a newer movement or user input, and as cancelled by cancel() or a signal (F200, F202)', async () => {
    const { globe, ticks } = await started({ longitudeDeg: 9, latitudeDeg: 45, zoom: 10 });
    const first = globe.flyTo({ longitudeDeg: 100, latitudeDeg: 20 });
    ticks(5);
    const second = globe.easeTo({ zoom: 8 }, { durationMs: 1000 });
    expect(await first).toBe('interrupted');
    ticks(5);
    globe.navigation.zoomAt({ xPx: 400, yPx: 300 }, 0.5);
    expect(await second).toBe('interrupted');
    const third = globe.easeTo({ zoom: 6 }, { durationMs: 1000 });
    ticks(3);
    const stoppedAt = globe.camera.zoom;
    third.cancel();
    expect(await third).toBe('cancelled');
    ticks(5);
    expect(globe.camera.zoom).toBeCloseTo(stoppedAt, 9);
    const controller = new AbortController();
    const fourth = globe.easeTo({ zoom: 4 }, { signal: controller.signal });
    ticks(2);
    controller.abort();
    expect(await fourth).toBe('cancelled');
    globe.destroy();
  });

  it('rejects invalid input with a typed error and moves nothing', async () => {
    const { globe } = await started({ longitudeDeg: 9, latitudeDeg: 45, zoom: 10 });
    await expect(globe.flyTo({ latitudeDeg: 95 })).rejects.toMatchObject({ code: 'invalid-coordinate' });
    await expect(globe.easeTo({ zoom: 5 }, { durationMs: -1 })).rejects.toMatchObject({ code: 'invalid-option' });
    for (const options of [{ speed: 0 }, { speed: Number.NaN }, { curve: -1 }, { easing: 'bounce' as 'linear' }])
      await expect(globe.flyTo({ zoom: 5 }, options)).rejects.toMatchObject({ code: 'invalid-option' });
    expect(globe.camera.zoom).toBeCloseTo(10, 9);
    globe.destroy();
  });

  it('keeps the chosen tilt, heading and view mode unless the call gives them (F201)', async () => {
    const { globe, ticks } = await started({ longitudeDeg: 9, latitudeDeg: 45, zoom: 15, tiltDeg: 40, headingDeg: 70 });
    ticks(5);
    // Every movement call without tilt or heading, a flight through the globe phase first.
    const calls = [
      () => globe.flyTo({ longitudeDeg: 139.69, latitudeDeg: 35.68 }),
      () => globe.easeTo({ longitudeDeg: 139.7, zoom: 15.5 }, { durationMs: 200 }),
      () => globe.jumpTo({ latitudeDeg: 35.7, zoom: 15 }),
      () => globe.tour([{ target: { longitudeDeg: 139.6 }, movement: 'ease', durationMs: 200 }]),
    ];
    for (const call of calls) {
      const movement = call();
      ticks(600);
      expect(await movement).toBe('completed');
      expect(globe.viewMode).toBe('manual');
      expect(globe.camera.chosenTiltDeg).toBeCloseTo(40, 9);
      expect(globe.camera.tiltDeg).toBeCloseTo(40, 6);
      expect(globe.camera.headingDeg).toBeCloseTo(70, 9);
    }
    // With a tilt and heading, each call applies them, and the view mode stays.
    let tilt = 10;
    for (const call of [
      () => globe.easeTo({ tiltDeg: tilt, headingDeg: tilt }, { durationMs: 200 }),
      () => globe.flyTo({ longitudeDeg: 12.5, latitudeDeg: 41.9, tiltDeg: tilt, headingDeg: tilt }),
      () => globe.jumpTo({ tiltDeg: tilt, headingDeg: tilt }),
    ]) {
      const movement = call();
      ticks(600);
      expect(await movement).toBe('completed');
      expect(globe.camera.tiltDeg).toBeCloseTo(tilt, 6);
      expect(globe.camera.headingDeg).toBeCloseTo(tilt, 9);
      expect(globe.viewMode).toBe('manual');
      tilt += 10;
    }
    globe.setViewMode('2d');
    const flight = globe.flyTo({ longitudeDeg: 9, latitudeDeg: 45 });
    ticks(600);
    expect(await flight).toBe('completed');
    expect(globe.viewMode).toBe('2d');
    globe.destroy();
  });

  it('a view mode chosen while a tilt eases wins: the ease does not choose its tilt again afterwards (KB-207)', async () => {
    const { globe, ticks } = await started({ longitudeDeg: 9, latitudeDeg: 45, zoom: 14 });
    const tilt = globe.tiltTo(30, { durationMs: 1000 });
    ticks(5);
    expect(globe.viewMode).toBe('manual');
    globe.setViewMode('2d');
    ticks(120);
    expect(globe.viewMode).toBe('2d');
    expect(globe.camera.tiltDeg).toBeCloseTo(0, 6);
    expect(await tilt).not.toBe('completed');
    globe.destroy();
  });

  it('announces a jump with the three events in one go, settled as completed, the next frame at the target (F197)', async () => {
    const { globe, ticks } = await started({ longitudeDeg: 9, latitudeDeg: 45, zoom: 10 });
    const events: string[] = [];
    for (const name of ['movestart', 'move', 'moveend'] as const) globe.on(name, () => events.push(name));
    const jump = globe.jumpTo({ longitudeDeg: 12.5, latitudeDeg: 41.9, zoom: 12, headingDeg: 15 });
    expect(events).toEqual(['movestart', 'move', 'moveend']);
    expect(await jump).toBe('completed');
    ticks(1);
    const { longitudeDeg, latitudeDeg, zoom, headingDeg } = globe.camera;
    for (const [shown, wanted] of [
      [longitudeDeg, 12.5],
      [latitudeDeg, 41.9],
      [zoom, 12],
      [headingDeg, 15],
    ] as const)
      expect(shown).toBeCloseTo(wanted, 12);
    globe.destroy();
  });

  it('settles flyTo, easeTo, jumpTo and tours as completed, cancels flights and tours by cancel() or a signal, and moves at most once per frame (F200)', async () => {
    const { globe, ticks } = await started({ longitudeDeg: 9, latitudeDeg: 45, zoom: 10 });
    let moves = 0;
    globe.on('move', () => moves++);
    const frames = globe.frameNumber;
    const flight = globe.flyTo({ longitudeDeg: 12, latitudeDeg: 42, zoom: 9 }, { durationMs: 300 });
    ticks(40);
    expect(await flight).toBe('completed');
    expect(moves).toBeLessThanOrEqual(globe.frameNumber - frames);
    expect(await globe.jumpTo({ zoom: 8 })).toBe('completed');
    expect(await globe.tour([{ target: { zoom: 9 }, movement: 'jump' }])).toBe('completed');
    const stops = [{ target: { longitudeDeg: 2, latitudeDeg: 48, zoom: 7 }, durationMs: 500 }];
    const starts = [
      (signal?: AbortController) =>
        globe.flyTo(
          { longitudeDeg: 100, latitudeDeg: 20 },
          { durationMs: 2000, ...(signal ? { signal: signal.signal } : {}) },
        ),
      (signal?: AbortController) => globe.tour(stops, signal ? { signal: signal.signal } : {}),
    ];
    for (const start of starts) {
      const cancelled = start();
      ticks(3);
      cancelled.cancel();
      expect(await cancelled).toBe('cancelled');
      const controller = new AbortController();
      const aborted = start(controller);
      ticks(2);
      const stoppedAt = globe.camera.zoom;
      controller.abort();
      expect(await aborted).toBe('cancelled');
      ticks(3);
      expect(globe.camera.zoom).toBeCloseTo(stoppedAt, 9);
    }
    globe.destroy();
  });
});

describe('tours with a long-lived signal', () => {
  it('stop listening to the signal once they end', async () => {
    const { globe } = await started({ longitudeDeg: 9, latitudeDeg: 45, zoom: 10 });
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, 'addEventListener');
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    for (let i = 0; i < 3; i++) {
      const tour = globe.tour([{ target: { zoom: 8 + i }, movement: 'jump' }], { signal: controller.signal });
      expect(await tour).toBe('completed');
    }
    await Promise.resolve();
    expect(removed.mock.calls.filter(([type]) => type === 'abort').length).toBe(
      added.mock.calls.filter(([type]) => type === 'abort').length,
    );
    globe.destroy();
  });
});

describe('fitting bounds and tours (F176, F199)', () => {
  it('frames a tall object on raised ground centered, and a lone point from a distance instead of at zoom 22 (KB-301)', async () => {
    const { globe, ticks } = await started({
      longitudeDeg: 9.4,
      latitudeDeg: 45.1,
      zoom: 12,
      headingDeg: 30,
      tiltDeg: 50,
    });
    // A 150 m turbine whose foot stands 70 m above the ellipsoid: its foot and its top must show, its middle centered.
    const foot = { longitudeDeg: 9.4, latitudeDeg: 45.1, heightMeters: 70 };
    const top = { ...foot, heightMeters: 220 };
    const point = { westDeg: 9.4, eastDeg: 9.4, southDeg: 45.1, northDeg: 45.1 };
    const movement = globe.fitBounds(point, { include: [foot, top], paddingPx: 40, movement: 'ease', durationMs: 100 });
    ticks(30);
    expect(await movement).toBe('completed');
    const middle = globe.geoToScreen({ ...foot, heightMeters: 145 });
    expect(Math.hypot((middle?.xPx ?? NaN) - 400, (middle?.yPx ?? NaN) - 300)).toBeLessThan(8);
    for (const shown of [globe.geoToScreen(foot), globe.geoToScreen(top)]) {
      expect(shown?.yPx).toBeGreaterThanOrEqual(39.9);
      expect(shown?.yPx).toBeLessThanOrEqual(560.1);
    }
    // Snug: one of the two touches the padding.
    const ys = [globe.geoToScreen(foot)?.yPx ?? NaN, globe.geoToScreen(top)?.yPx ?? NaN];
    expect(Math.min(ys[0] ?? NaN, ys[1] ?? NaN) - 40 < 3 || 560 - Math.max(ys[0] ?? NaN, ys[1] ?? NaN) < 3).toBe(true);
    // A lone point with nothing above it: framed from 100 m away, not from the 2 m of zoom 22.
    const lone = globe.fitBounds(point, { movement: 'ease', durationMs: 100 });
    ticks(30);
    expect(await lone).toBe('completed');
    const distance = globe.camera.altitudeMeters / Math.cos((globe.camera.tiltDeg * Math.PI) / 180);
    expect(distance).toBeGreaterThan(99);
    expect(distance).toBeLessThan(110);
    // From a tilt given (F667): a plant seen from 30°, still framed and centered.
    const tilted = globe.fitBounds(point, {
      include: [foot, top],
      paddingPx: 40,
      tiltDeg: 30,
      movement: 'ease',
      durationMs: 100,
    });
    ticks(30);
    expect(await tilted).toBe('completed');
    expect(globe.camera.tiltDeg).toBeCloseTo(30, 6);
    const centered = globe.geoToScreen({ ...foot, heightMeters: 145 });
    expect(Math.hypot((centered?.xPx ?? NaN) - 400, (centered?.yPx ?? NaN) - 300)).toBeLessThan(8);
    await expect(globe.fitBounds(point, { tiltDeg: 120 })).rejects.toMatchObject({ code: 'invalid-coordinate' });
    globe.destroy();
  });

  it.each([
    [30, 20],
    [-60, 0],
    [0, 40],
  ])(
    'fits a city, a country, an antimeridian area and a near-polar area inside the padded viewport, heading %d° and tilt %d°',
    async (headingDeg, tiltDeg) => {
      const { globe, ticks } = await started({ longitudeDeg: 0, latitudeDeg: 20, zoom: 3, headingDeg, tiltDeg });
      for (const [bounds, padding] of [
        [{ westDeg: 12.4, southDeg: 41.8, eastDeg: 12.6, northDeg: 42 }, 20],
        [{ westDeg: 6.6, southDeg: 36.6, eastDeg: 18.5, northDeg: 47.1 }, 30],
        [{ westDeg: 170, southDeg: -20, eastDeg: -170, northDeg: -10 }, 40],
        [{ westDeg: 10, southDeg: 75, eastDeg: 30, northDeg: 80 }, 10],
      ] as const) {
        const movement = globe.fitBounds(bounds, { paddingPx: padding, movement: 'ease', durationMs: 100 });
        ticks(30);
        expect(await movement).toBe('completed');
        let touching = Infinity;
        for (let i = 0; i <= 8; i++) {
          const f = i / 8;
          const width =
            bounds.eastDeg >= bounds.westDeg ? bounds.eastDeg - bounds.westDeg : bounds.eastDeg + 360 - bounds.westDeg;
          let lon = bounds.westDeg + f * width;
          if (lon > 180) lon -= 360;
          for (const point of [
            globe.geoToScreen({ longitudeDeg: lon, latitudeDeg: bounds.southDeg }),
            globe.geoToScreen({ longitudeDeg: lon, latitudeDeg: bounds.northDeg }),
          ]) {
            if (!point) throw new Error('a bound is not on screen');
            expect(point.xPx).toBeGreaterThanOrEqual(padding - 0.01);
            expect(point.xPx).toBeLessThanOrEqual(800 - padding + 0.01);
            expect(point.yPx).toBeGreaterThanOrEqual(padding - 0.01);
            expect(point.yPx).toBeLessThanOrEqual(600 - padding + 0.01);
            touching = Math.min(
              touching,
              point.xPx - padding,
              800 - padding - point.xPx,
              point.yPx - padding,
              600 - padding - point.yPx,
            );
          }
        }
        // An edge sample touches the padding: as large as it can be.
        expect(touching).toBeLessThan(2);
        expect(globe.camera.headingDeg).toBeCloseTo(headingDeg, 6);
      }
      await expect(globe.fitBounds({ westDeg: 0, southDeg: 10, eastDeg: 5, northDeg: 5 })).rejects.toMatchObject({
        code: 'invalid-coordinate',
      });
      globe.destroy();
    },
  );

  it('plays the waypoints in order with their dwell times, and settles as completed, cancelled or interrupted', async () => {
    const { globe, ticks } = await started({ longitudeDeg: 0, latitudeDeg: 20, zoom: 3 });
    const reached: number[] = [];
    globe.on('tour-waypoint', ({ index }) => reached.push(index));
    const stops = [
      { target: { longitudeDeg: 10, latitudeDeg: 45, zoom: 6 }, durationMs: 300, dwellMs: 200 },
      { target: { longitudeDeg: 12, latitudeDeg: 42, zoom: 8 }, movement: 'ease' as const, durationMs: 200 },
      { target: { longitudeDeg: 2, latitudeDeg: 48, zoom: 7 }, movement: 'jump' as const },
      { target: { longitudeDeg: -3, latitudeDeg: 40, zoom: 6 }, durationMs: 300, dwellMs: 100 },
      { target: { longitudeDeg: 9, latitudeDeg: 45, zoom: 9 }, movement: 'ease' as const, durationMs: 200 },
    ];
    const tour = globe.tour(stops);
    for (let i = 0; i < 200 && reached.length < 5; i++) {
      ticks(5);
      await Promise.resolve();
    }
    expect(await tour).toBe('completed');
    expect(reached).toEqual([0, 1, 2, 3, 4]);
    expect(globe.camera.zoom).toBeCloseTo(9, 6);
    const cancelled = globe.tour(stops);
    ticks(3);
    cancelled.cancel();
    expect(await cancelled).toBe('cancelled');
    const taken = globe.tour(stops);
    ticks(3);
    globe.navigation.zoomAt({ xPx: 400, yPx: 300 }, 0.5);
    expect(await taken).toBe('interrupted');
    globe.destroy();
  });
});

describe('orientation, orbit, reset and home (F191–F194)', () => {
  it('turns to each compass direction along the shorter arc, keeping center and tilt (F191)', async () => {
    const { globe, ticks } = await started({
      longitudeDeg: 9,
      latitudeDeg: 45,
      zoom: 15,
      tiltDeg: 30,
      headingDeg: 300,
    });
    for (const heading of [0, 90, 180, 270]) {
      const turn = globe.rotateTo(heading, { durationMs: 200 });
      ticks(20);
      expect(await turn).toBe('completed');
      // The public heading lies in [−180°, 180°).
      const wrapped = ((((heading + 180) % 360) + 360) % 360) - 180;
      expect(globe.camera.headingDeg).toBeCloseTo(wrapped, 9);
      expect(globe.camera.chosenHeadingDeg).toBeCloseTo(wrapped, 9);
      expect(globe.camera.longitudeDeg).toBeCloseTo(9, 9);
      expect(globe.camera.tiltDeg).toBeCloseTo(30, 6);
    }
    globe.destroy();
  });

  it('orbits a given point keeping it fixed on screen at a constant distance, until cancelled (F192)', async () => {
    const { globe, ticks } = await started({ longitudeDeg: 9, latitudeDeg: 45, zoom: 15, tiltDeg: 45 });
    ticks(3);
    const center = { longitudeDeg: 9.002, latitudeDeg: 45.001 };
    const start = globe.geoToScreen(center);
    if (!start) throw new Error('center off screen');
    const orbit = globe.orbit({ center, degreesPerSecond: 30 });
    for (let i = 0; i < 30; i++) {
      ticks(1);
      const shown = globe.geoToScreen(center);
      expect(Math.hypot((shown?.xPx ?? NaN) - start.xPx, (shown?.yPx ?? NaN) - start.yPx)).toBeLessThan(1);
    }
    expect(globe.camera.headingDeg).toBeGreaterThan(5);
    orbit.cancel();
    expect(await orbit).toBe('cancelled');
    globe.destroy();
  });

  it('resets to the whole globe over the current place, and flies home with its view mode (F193, F194)', async () => {
    const { renderer, factory } = (await import('./test-renderer.js')).fakeRenderer();
    const home = { longitudeDeg: 2.35, latitudeDeg: 48.86, zoom: 12, headingDeg: 45, viewMode: '2d' as const };
    const globe = createGlobe({
      container: {},
      renderer: factory,
      baseImageryUrl: 'w',
      view: { longitudeDeg: 9, latitudeDeg: 45, zoom: 17 },
      home,
    });
    await Promise.resolve();
    await Promise.resolve();
    renderer.flush();
    await globe.ready;
    const ticks = (count: number): void => {
      for (let i = 0; i < count; i++) {
        renderer.timers.advance(16);
        renderer.flush();
      }
    };
    const reset = globe.resetToGlobe();
    ticks(600);
    expect(await reset).toBe('completed');
    expect(globe.camera.longitudeDeg).toBeCloseTo(9, 9);
    expect(globe.camera.latitudeDeg).toBeCloseTo(45, 9);
    expect(globe.camera.phase).toBe('globe');
    // The whole globe: the eye three Earth radii from the target, wider than the Earth in view.
    expect(globe.camera.rangeMeters).toBeCloseTo(3 * 6378137, -3);
    const homeward = globe.goHome();
    ticks(600);
    expect(await homeward).toBe('completed');
    expect(globe.viewMode).toBe('2d');
    expect([globe.camera.longitudeDeg, globe.camera.latitudeDeg]).toEqual([
      expect.closeTo(2.35, 9),
      expect.closeTo(48.86, 9),
    ]);
    expect(globe.camera.zoom).toBeCloseTo(12, 6);
    expect(globe.camera.headingDeg).toBeCloseTo(45, 9);
    expect(() =>
      createGlobe({ container: {}, renderer: factory, baseImageryUrl: 'w', home: { latitudeDeg: 99 } }),
    ).toThrow(expect.objectContaining({ code: 'invalid-coordinate' }));
    globe.destroy();
  });
});

describe('camera constraints (F209–F211)', () => {
  it('holds the zoom range, the maximum tilt and the bounds for input and movements', async () => {
    const { globe, ticks } = await started({ longitudeDeg: 9, latitudeDeg: 45, zoom: 10 });
    globe.setConstraints({
      minZoom: 5,
      maxZoom: 12,
      maxTiltDeg: 30,
      bounds: { westDeg: 170, southDeg: -50, eastDeg: -170, northDeg: 50 },
    });
    // Readable back, for controls that disable their buttons at the limits (track A hook request 3).
    expect(globe.constraints).toMatchObject({ minZoom: 5, maxZoom: 12, maxTiltDeg: 30 });
    ticks(2);
    // The center moves into the bounds across the antimeridian, to the nearer edge.
    expect(Math.abs(globe.camera.longitudeDeg)).toBeGreaterThanOrEqual(170 - 1e-9);
    for (let i = 0; i < 20; i++) {
      globe.navigation.zoomAt({ xPx: 400, yPx: 300 }, 1);
      ticks(1);
      expect(globe.camera.zoom).toBeLessThanOrEqual(12 + 1e-6);
    }
    const out = globe.flyTo({ longitudeDeg: 0, latitudeDeg: 0, zoom: 2, tiltDeg: 60 });
    for (let i = 0; i < 600; i++) {
      ticks(1);
      expect(globe.camera.zoom).toBeGreaterThanOrEqual(5 - 1e-6);
      expect(globe.camera.zoom).toBeLessThanOrEqual(12 + 1e-6);
      expect(globe.camera.tiltDeg).toBeLessThanOrEqual(30 + 1e-6);
      expect(globe.camera.chosenTiltDeg).toBeLessThanOrEqual(30 + 1e-6);
      const lon = globe.camera.longitudeDeg;
      expect(lon >= 170 - 1e-6 || lon <= -170 + 1e-6).toBe(true);
    }
    await out;
    expect(() => globe.setConstraints({ minZoom: 9, maxZoom: 3 })).toThrow(
      expect.objectContaining({ code: 'invalid-option' }),
    );
    globe.destroy();
  });

  it('holds a farthest range at every latitude: zooming out stops there and a drag toward a pole keeps it (F646)', async () => {
    const { globe, ticks } = await started({ longitudeDeg: 12, latitudeDeg: 45, zoom: 3 });
    globe.setConstraints({ maxRangeMeters: 1.8e7 });
    ticks(1);
    for (let i = 0; i < 8; i++) {
      globe.navigation.zoomAt({ xPx: 400, yPx: 300 }, -1);
      ticks(1);
    }
    expect(globe.camera.rangeMeters).toBeCloseTo(1.8e7, -2);
    const zoomAt45 = globe.camera.zoom;
    let northmost = 0;
    let lowestZoom = zoomAt45;
    for (let i = 0; i < 12; i++) {
      const anchor = globe.navigation.grab({ xPx: 400, yPx: 300 });
      if (anchor) globe.navigation.dragTo(anchor, { xPx: 400, yPx: 340 });
      ticks(1);
      expect(globe.camera.rangeMeters).toBeCloseTo(1.8e7, -2);
      northmost = Math.max(northmost, globe.camera.latitudeDeg);
      lowestZoom = Math.min(lowestZoom, globe.camera.zoom);
    }
    expect(northmost).toBeGreaterThan(70);
    // The Web Mercator zoom falls with the latitude at the same range.
    expect(lowestZoom).toBeLessThan(zoomAt45 - 1);
    expect(() => globe.setConstraints({ maxRangeMeters: 0 })).toThrow(
      expect.objectContaining({ code: 'invalid-option' }),
    );
    globe.destroy();
  });

  it('does not pan when zooming at an off-center point beyond the zoom limits (KB-126)', async () => {
    const { globe, ticks } = await started({ longitudeDeg: 9, latitudeDeg: 45, zoom: 12 });
    globe.setConstraints({ minZoom: 5, maxZoom: 12 });
    ticks(1);
    const { longitudeDeg, latitudeDeg } = globe.camera;
    for (const delta of [0.3, -0, 0.3]) {
      globe.navigation.zoomAt({ xPx: 700, yPx: 100 }, delta);
      ticks(1);
    }
    expect(globe.camera.zoom).toBeCloseTo(12, 3);
    expect(globe.camera.longitudeDeg).toBeCloseTo(longitudeDeg, 9);
    expect(globe.camera.latitudeDeg).toBeCloseTo(latitudeDeg, 9);
    // Up to the limit, the cursor point stays put; the zoom then stops there.
    globe.jumpTo({ zoom: 11.9 });
    ticks(1);
    const under = globe.screenToGeo({ xPx: 700, yPx: 100 });
    globe.navigation.zoomAt({ xPx: 700, yPx: 100 }, 0.5);
    ticks(1);
    expect(globe.camera.zoom).toBeCloseTo(12, 3);
    const after = globe.screenToGeo({ xPx: 700, yPx: 100 });
    expect(after?.longitudeDeg).toBeCloseTo(under?.longitudeDeg ?? 0, 5);
    expect(after?.latitudeDeg).toBeCloseTo(under?.latitudeDeg ?? 0, 5);
    globe.destroy();
  });

  it('keeps the default tilt of 3D mode under the maximum tilt, and flies to a target outside the bounds without a jump (KB-123)', async () => {
    const { globe, ticks } = await started({ longitudeDeg: 10, latitudeDeg: 45, zoom: 14 });
    globe.setConstraints({ maxTiltDeg: 30, bounds: { westDeg: 5, southDeg: 40, eastDeg: 15, northDeg: 50 } });
    globe.setViewMode('3d');
    ticks(1);
    expect(globe.camera.chosenTiltDeg).toBeLessThanOrEqual(30 + 1e-9);
    const flight = globe.flyTo({ longitudeDeg: 40, latitudeDeg: -60, zoom: 6 }, { durationMs: 800 });
    let last = globe.camera;
    for (let i = 0; i < 80; i++) {
      ticks(1);
      const now = globe.camera;
      expect(Math.hypot(now.longitudeDeg - last.longitudeDeg, now.latitudeDeg - last.latitudeDeg)).toBeLessThan(1);
      last = now;
    }
    expect(await flight).toBe('completed');
    // At the nearest corner of the bounds.
    expect(globe.camera.longitudeDeg).toBeCloseTo(15, 6);
    expect(globe.camera.latitudeDeg).toBeCloseTo(40, 6);
    globe.destroy();
  });

  it('fades a flight to its target under the reduced-motion setting, following changes at runtime (F214)', async () => {
    const { renderer, factory } = fakeRenderer();
    let setReduce: (reduce: boolean) => void = () => undefined;
    const opacities: number[] = [];
    Object.assign(renderer.host, {
      observeReducedMotion: (callback: (reduce: boolean) => void) => {
        setReduce = callback;
        callback(true);
        return () => undefined;
      },
      setOpacity: (opacity: number) => opacities.push(opacity),
    });
    const globe = createGlobe({
      container: {},
      renderer: factory,
      baseImageryUrl: 'w',
      view: { longitudeDeg: 9.19, latitudeDeg: 45.46, zoom: 15 },
    });
    await Promise.resolve();
    await Promise.resolve();
    renderer.flush();
    await globe.ready;
    expect(globe.reducedMotion).toBe(true);
    const longitudes: number[] = [];
    globe.on('move', () => longitudes.push(globe.camera.longitudeDeg));
    const flight = globe.flyTo({ longitudeDeg: 139.69, latitudeDeg: 35.68, zoom: 15 });
    for (let i = 0; i < 30; i++) {
      renderer.timers.advance(16);
      renderer.flush();
    }
    expect(await flight).toBe('completed');
    // Never between the two places: at the start until the jump, then at the target.
    expect(longitudes.every((lon) => Math.abs(lon - 9.19) < 1e-9 || Math.abs(lon - 139.69) < 1e-9)).toBe(true);
    expect(globe.camera.longitudeDeg).toBeCloseTo(139.69, 9);
    expect(Math.min(...opacities)).toBeLessThan(0.1);
    expect(opacities.at(-1)).toBe(1);
    // Within the 300 ms fade.
    expect(longitudes.length).toBeLessThanOrEqual(Math.ceil(300 / 16) + 1);
    setReduce(false);
    const full = globe.flyTo({ longitudeDeg: 9.19, latitudeDeg: 45.46, zoom: 15 });
    for (let i = 0; i < 600; i++) {
      renderer.timers.advance(16);
      renderer.flush();
    }
    expect(await full).toBe('completed');
    expect(longitudes.some((lon) => lon > 20 && lon < 130)).toBe(true);
    globe.destroy();
  });

  it('tilts with the tilt control to a chosen tilt, from 2D too, never past the maximum tilt (F188)', async () => {
    const { globe, ticks } = await started({ longitudeDeg: 9, latitudeDeg: 45, zoom: 15 });
    globe.setViewMode('2d');
    ticks(120);
    const tilts: number[] = [];
    globe.on('move', () => tilts.push(globe.camera.tiltDeg));
    const movement = globe.tiltTo(40, { durationMs: 500 });
    ticks(60);
    expect(await movement).toBe('completed');
    expect(globe.camera.tiltDeg).toBeCloseTo(40, 6);
    expect(globe.camera.chosenTiltDeg).toBeCloseTo(40, 6);
    expect(globe.viewMode).toBe('manual');
    // Animated: rising through the frames, never in one step.
    expect(tilts.length).toBeGreaterThan(10);
    for (let i = 1; i < tilts.length; i++) expect((tilts[i] ?? 0) - (tilts[i - 1] ?? 0)).toBeLessThan(10);
    globe.setConstraints({ maxTiltDeg: 30 });
    const capped = globe.tiltTo(60, { durationMs: 300 });
    ticks(40);
    expect(await capped).toBe('completed');
    expect(globe.camera.tiltDeg).toBeLessThanOrEqual(30 + 1e-9);
    expect(globe.camera.chosenTiltDeg).toBeLessThanOrEqual(30 + 1e-9);
    await expect(globe.tiltTo(Number.NaN)).rejects.toMatchObject({ code: 'invalid-coordinate' });
    globe.destroy();
  });
});

describe('the view an input heads for (F672)', () => {
  it('loads a valid view ahead as a movement destination keeping the tilt, and stops on undefined or an invalid one', () => {
    const cam = new Camera();
    cam.widthPx = 800;
    cam.heightPx = 600;
    cam.update();
    const ends: (Float64Array | undefined)[] = [];
    const movements = new Movements({
      cam,
      currentView: () => currentView(cam),
      constrainEnd: () => undefined,
      preloadView: (end: Float64Array | undefined) => ends.push(end),
    } as unknown as MovementHost);
    movements.preload({ longitudeDeg: 10, latitudeDeg: 45, zoom: 12 });
    movements.preload({ latitudeDeg: 99 });
    movements.preload(undefined);
    const [end] = ends;
    expect([end?.[0], end?.[1]]).toEqual([(10 * Math.PI) / 180, (45 * Math.PI) / 180]);
    expect(end?.[2]).toBeCloseTo(
      rangeForGroundZoom(groundZoomFromMercatorZoom(12, (45 * Math.PI) / 180), 600, cam.fovYRad),
      6,
    );
    expect(end?.[4]).toBeNaN();
    expect(ends.slice(1)).toEqual([undefined, undefined]);
  });
});
