// F202: user input interrupts every kind of camera movement and takes over from the current state without a jump.
import { expect, test, type Page } from '@playwright/test';
import { openGlobe } from './support/globe.ts';
import { Touch } from './support/controls.ts';

test.use({ viewport: { width: 320, height: 240 }, hasTouch: true });

type Movement = 'flyTo' | 'easeTo' | 'tour' | 'orbit' | 'inertia';
type Input = 'wheel' | 'drag' | 'touch' | 'keyboard';
interface Pose {
  lon: number;
  lat: number;
  zoom: number;
  heading: number;
}

/** Starts the movement; its outcome lands in `window.movementOutcome`. */
async function start(page: Page, movement: Movement): Promise<void> {
  if (movement === 'inertia') {
    await page.mouse.move(100, 120);
    await page.mouse.down();
    await page.mouse.move(200, 120, { steps: 4 });
    await page.mouse.up();
    return;
  }
  await page.evaluate((kind) => {
    const globe = window.vibeglobePlayground?.globe;
    if (!globe) throw new Error('no globe');
    const record = window as unknown as { movementOutcome?: string | undefined };
    record.movementOutcome = undefined;
    const movement =
      kind === 'flyTo'
        ? globe.flyTo({ longitudeDeg: 40, latitudeDeg: 30, zoom: 3.5 }, { durationMs: 8000 })
        : kind === 'easeTo'
          ? globe.easeTo({ longitudeDeg: 30, latitudeDeg: 45, zoom: 3.5 }, { durationMs: 8000 })
          : kind === 'tour'
            ? globe.tour([{ target: { longitudeDeg: 30, latitudeDeg: 45 }, movement: 'ease', durationMs: 8000 }])
            : globe.orbit({ degreesPerSecond: 20 });
    void movement.then((outcome) => (record.movementOutcome = outcome));
  }, movement);
}

async function interrupt(page: Page, input: Input, touch: Touch): Promise<void> {
  if (input === 'wheel') {
    await page.mouse.move(160, 120);
    await page.mouse.wheel(0, -100);
  } else if (input === 'drag') {
    await page.mouse.move(160, 120);
    await page.mouse.down();
    await page.mouse.move(190, 130, { steps: 5 });
    await page.mouse.up();
  } else if (input === 'touch') {
    await touch.start([{ id: 1, x: 160, y: 120 }]);
    for (let i = 1; i <= 5; i++) await touch.move([{ id: 1, x: 160 + 6 * i, y: 120 + 2 * i }]);
    await touch.end();
  } else {
    await page.focus('#globe');
    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(300);
    await page.keyboard.up('ArrowRight');
  }
}

test('wheel, drag, touch and keyboard input interrupt flights, eases, tours, orbits and inertia without a jump (F202)', async ({
  page,
}) => {
  // Twenty interruptions of real-time movements, drawn on the software GPU.
  test.setTimeout(180_000);
  await openGlobe(page, 'backend=webgl2&lon=10&lat=45&zoom=3');
  const touch = await Touch.create(page);
  await page.evaluate(() => {
    const globe = window.vibeglobePlayground?.globe;
    if (!globe) throw new Error('no globe');
    const record = window as unknown as { poses: Pose[] };
    record.poses = [];
    globe.on('frame', () => {
      const c = globe.camera;
      record.poses.push({ lon: c.longitudeDeg, lat: c.latitudeDeg, zoom: c.zoom, heading: c.headingDeg });
    });
  });
  const failures: string[] = [];
  for (const movement of ['flyTo', 'easeTo', 'tour', 'orbit', 'inertia'] as const) {
    for (const input of ['wheel', 'drag', 'touch', 'keyboard'] as const) {
      await page.evaluate(() =>
        window.vibeglobePlayground?.globe.jumpTo({
          longitudeDeg: 10,
          latitudeDeg: 45,
          zoom: 3,
          headingDeg: 0,
          tiltDeg: 0,
        }),
      );
      await page.waitForTimeout(200);
      await start(page, movement);
      await page.waitForTimeout(movement === 'inertia' ? 50 : 600);
      const takeover = await page.evaluate(() => (window as unknown as { poses: Pose[] }).poses.length);
      await interrupt(page, input, touch);
      await page.waitForTimeout(800);
      const { poses, outcome } = await page.evaluate(() => {
        const record = window as unknown as { poses: Pose[]; movementOutcome?: string };
        return { poses: record.poses, outcome: record.movementOutcome };
      });
      if (movement !== 'inertia' && outcome !== 'interrupted')
        failures.push(`${movement}/${input}: outcome ${outcome}`);
      // Frame-to-frame changes around the takeover, in screen pixels at the frame's zoom (256 px per 360° at zoom 0): a
      // jump to the target or back to an earlier state is hundreds; a fast frame of inertia on a slow machine, tens.
      for (let i = Math.max(1, takeover - 2); i < poses.length; i++) {
        const [a, b] = [poses[i - 1], poses[i]];
        if (!a || !b) continue;
        const dLon = Math.abs((((b.lon - a.lon + 540) % 360) - 180) * Math.cos((a.lat * Math.PI) / 180));
        const stepPx = ((Math.hypot(dLon, b.lat - a.lat) * 256) / 360) * 2 ** Math.max(a.zoom, b.zoom);
        const dHeading = Math.abs(((b.heading - a.heading + 540) % 360) - 180);
        if (stepPx > 60 || Math.abs(b.zoom - a.zoom) > 0.5 || dHeading > 10)
          failures.push(`${movement}/${input}: jump at frame ${i} ${JSON.stringify([a, b])}`);
      }
      await page.evaluate(() => ((window as unknown as { poses: Pose[] }).poses = []));
    }
  }
  expect(failures).toEqual([]);
});
