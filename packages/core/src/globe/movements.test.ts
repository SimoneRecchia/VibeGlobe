import { describe, expect, it } from 'vitest';
import { createGlobe } from './create-globe.js';
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
    expect(globe.camera.zoom).toBeCloseTo(10, 9);
    globe.destroy();
  });

  it('keeps the chosen tilt, heading and view mode unless the call gives them (F201)', async () => {
    const { globe, ticks } = await started({ longitudeDeg: 9, latitudeDeg: 45, zoom: 15, tiltDeg: 40, headingDeg: 70 });
    ticks(5);
    const flight = globe.flyTo({ longitudeDeg: 139.69, latitudeDeg: 35.68 });
    ticks(600);
    expect(await flight).toBe('completed');
    expect(globe.viewMode).toBe('manual');
    expect(globe.camera.chosenTiltDeg).toBeCloseTo(40, 9);
    expect(globe.camera.tiltDeg).toBeCloseTo(40, 6);
    expect(globe.camera.headingDeg).toBeCloseTo(70, 9);
    const ease = globe.easeTo({ tiltDeg: 10, headingDeg: 0 }, { durationMs: 200 });
    ticks(40);
    expect(await ease).toBe('completed');
    expect(globe.camera.tiltDeg).toBeCloseTo(10, 6);
    expect(globe.camera.headingDeg).toBeCloseTo(0, 9);
    globe.destroy();
  });

  it('announces a jump with the three events in one go (F197)', async () => {
    const { globe } = await started({ longitudeDeg: 9, latitudeDeg: 45, zoom: 10 });
    const events: string[] = [];
    for (const name of ['movestart', 'move', 'moveend'] as const) globe.on(name, () => events.push(name));
    globe.jumpTo({ zoom: 12 });
    expect(events).toEqual(['movestart', 'move', 'moveend']);
    globe.destroy();
  });
});

describe('fitting bounds and tours (F176, F199)', () => {
  it('fits a city, an antimeridian area and a near-polar area inside the padded viewport, with heading and tilt', async () => {
    const { globe, ticks } = await started({ longitudeDeg: 0, latitudeDeg: 20, zoom: 3, headingDeg: 30, tiltDeg: 20 });
    for (const [bounds, padding] of [
      [{ westDeg: 12.4, southDeg: 41.8, eastDeg: 12.6, northDeg: 42 }, 20],
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
      expect(globe.camera.headingDeg).toBeCloseTo(30, 6);
    }
    await expect(globe.fitBounds({ westDeg: 0, southDeg: 10, eastDeg: 5, northDeg: 5 })).rejects.toMatchObject({
      code: 'invalid-coordinate',
    });
    globe.destroy();
  });

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
