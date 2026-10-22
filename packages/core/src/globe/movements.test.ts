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
