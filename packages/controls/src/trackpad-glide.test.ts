import { describe, expect, it } from 'vitest';
import { controlsHarness, OrthoGlobe } from './test-harness.js';

// KB-202: flicks on a zoomed-out globe, as a trackpad sends them, glide to rest: no instant stop, no jerk, no reversal,
// and drags that leave the globe's disc keep turning it. The globe of the harness is 250 px in radius at the center of
// an 800 × 600 canvas, surrounded by space; sequences are made at 120 and 60 Hz.

const CX = 400;
const CY = 300;
const RADIUS_PX = 250;

/** A pointer sequence: move events at the device's rate along x, the speed (px/ms) a function of time, then a lift. */
interface Sequence {
  readonly name: string;
  /** Pointer speed in px/ms at time t since the press. */
  speed(tMs: number): number;
  readonly durationMs: number;
  readonly startX: number;
  /** Time from the last move to the lift (a trackpad sends nothing while the finger rests). */
  readonly liftAfterMs: number;
}

const FAST: Sequence = {
  name: 'fast flick released at once',
  speed: (t) => 1.8 * Math.min(1, t / 40),
  durationMs: 120,
  startX: CX - 120,
  liftAfterMs: 2,
};
const SLOWING: Sequence = {
  name: 'flick slowing down before the lift',
  speed: (t) => (t < 90 ? 1.8 * Math.min(1, t / 40) : 1.8 - (1.3 * (t - 90)) / 50),
  durationMs: 140,
  startX: CX - 140,
  liftAfterMs: 10,
};
const GENTLE: Sequence = {
  name: 'gentle flick',
  speed: (t) => 0.3 * Math.min(1, t / 40),
  durationMs: 200,
  startX: CX - 40,
  liftAfterMs: 4,
};

interface Run {
  /** The angle the globe turned in each frame, radians, and whether the pointer was still down. */
  readonly steps: { angle: number; down: boolean; direction: [number, number, number] }[];
}

/** Plays a sequence at `eventHz` with frames at `frameHz` on a fresh zoomed-out globe, for `glideMs` after the lift. */
function play(sequence: Sequence, eventHz: number, frameHz: number, glideMs = 9000, y = CY): Run {
  const h = controlsHarness(undefined, { globeRadiusPx: RADIUS_PX });
  const globe = h.camera as OrthoGlobe;
  const eventMs = 1000 / eventHz;
  const frameMs = 1000 / frameHz;
  // Event times are host times; the engine clock starts at 0 too (`hostNow` 0, frames advance it).
  const events: { type: string; x: number; t: number }[] = [{ type: 'pointerdown', x: sequence.startX, t: 0 }];
  let x = sequence.startX;
  let t = 0;
  while (t + eventMs <= sequence.durationMs) {
    const next = t + eventMs;
    x += sequence.speed(next) * eventMs;
    t = next;
    events.push({ type: 'pointermove', x, t });
  }
  const liftMs = t + sequence.liftAfterMs;
  events.push({ type: 'pointerup', x, t: liftMs });
  const steps: Run['steps'] = [];
  let previous = globe.centerVector();
  let down = true;
  for (let frameAt = frameMs; frameAt <= liftMs + glideMs; frameAt += frameMs) {
    while (events.length > 0 && (events[0]?.t ?? Infinity) <= frameAt) {
      const event = events.shift();
      if (!event) break;
      h.pointer(event.type, { x: event.x, y, t: event.t });
      if (event.type === 'pointerup') down = false;
    }
    h.frame(frameMs);
    const now = globe.centerVector();
    const d: [number, number, number] = [now[0] - previous[0], now[1] - previous[1], now[2] - previous[2]];
    steps.push({ angle: Math.hypot(...d), down, direction: d });
    previous = now;
  }
  return { steps };
}

/** Angular speed at the end of the drag: its last frame that moved, radians per frame. */
function releaseSpeed(run: Run): number {
  return run.steps.filter((s) => s.down && s.angle > 0).at(-1)?.angle ?? 0;
}

function glide(run: Run): Run['steps'] {
  return run.steps.filter((s) => !s.down);
}

function dot(a: [number, number, number], b: [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

describe('trackpad flicks on a zoomed-out globe (KB-202)', () => {
  for (const [eventHz, frameHz] of [
    [120, 120],
    [60, 60],
  ] as const) {
    for (const sequence of [FAST, SLOWING, GENTLE]) {
      it(`a ${sequence.name} at ${eventHz} Hz glides on and slows down smoothly to rest, never reversing`, () => {
        const run = play(sequence, eventHz, frameHz);
        const v0 = releaseSpeed(run);
        const after = glide(run);
        expect(v0).toBeGreaterThan(0);
        // No instant stop and no extra jerk: the first frames of the glide turn the globe about as fast as the drag did.
        expect(after[0]?.angle ?? 0, 'first glide frame').toBeGreaterThan(0.6 * v0);
        expect(after[0]?.angle ?? 0, 'first glide frame').toBeLessThan(1.5 * v0);
        // Monotonic slowdown to rest.
        for (let i = 1; i < after.length; i++)
          expect(after[i]?.angle ?? 0, `glide frame ${i}`).toBeLessThanOrEqual(
            (after[i - 1]?.angle ?? 0) * 1.001 + 1e-12,
          );
        expect(after.at(-1)?.angle ?? 1, 'at rest').toBeLessThan(1e-6);
        // It lasts: at least half a second of motion above a tenth of the release speed.
        const gliding = after.filter((s) => s.angle > 0.1 * v0).length;
        expect(gliding * (1000 / frameHz), 'glide duration ms').toBeGreaterThan(500);
        // One direction from the last drag frame through the whole glide: never a reversal or bounce (consecutive
        // steps, since the path's tangent turns as the globe does).
        const lastDrag = run.steps.filter((s) => s.down && s.angle > 0).at(-1);
        const moving = run.steps.filter((s) => s.angle > 1e-9);
        for (let i = Math.max(1, lastDrag ? moving.indexOf(lastDrag) : 1); i < moving.length; i++) {
          const [previous, step] = [moving[i - 1], moving[i]];
          if (previous && step) expect(dot(step.direction, previous.direction), `step ${i}`).toBeGreaterThan(0);
        }
      });
    }

    it(`the glide's length is proportional to the release speed at ${eventHz} Hz`, () => {
      const ratios = [FAST, GENTLE].map((sequence) => {
        const run = play(sequence, eventHz, frameHz);
        const total = glide(run).reduce((sum, s) => sum + s.angle, 0);
        return total / releaseSpeed(run);
      });
      expect(Math.abs((ratios[0] ?? 0) / (ratios[1] ?? 1) - 1)).toBeLessThan(0.15);
    });
  }

  it('a drag that leaves the globe keeps turning it, and its release still glides', () => {
    // From the center to 400 px right, past the edge at 250 px, at 0.6 px/ms.
    const run = play({ name: 'off the disc', speed: () => 0.6, durationMs: 666, startX: CX, liftAfterMs: 2 }, 120, 120);
    const drag = run.steps.filter((s) => s.down);
    // The last 150 ms of the drag are beyond the edge: the globe keeps turning there.
    const offDisc = drag.slice(-18);
    expect(offDisc.every((s) => s.angle > 0)).toBe(true);
    expect(glide(run)[0]?.angle ?? 0).toBeGreaterThan(0.6 * releaseSpeed(run));
  });

  it('a release on empty space after holding still ends without a glide', () => {
    const h = controlsHarness(undefined, { globeRadiusPx: RADIUS_PX });
    const globe = h.camera as OrthoGlobe;
    h.pointer('pointerdown', { x: CX, y: CY, t: 0 });
    for (let t = 8; t <= 600; t += 8) {
      h.pointer('pointermove', { x: CX + 0.6 * t, y: CY, t });
      h.frame(8);
    }
    // Held 300 ms beyond the edge, then lifted.
    for (let t = 608; t <= 900; t += 8) h.frame(8);
    h.pointer('pointerup', { x: CX + 360, y: CY, t: 900 });
    const before = globe.centerVector();
    h.run(h.globe.timeMs + 1000, 8);
    const after = globe.centerVector();
    expect(Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2])).toBeLessThan(1e-9);
  });
});
