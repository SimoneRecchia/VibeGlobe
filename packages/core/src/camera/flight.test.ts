import { describe, expect, it } from 'vitest';
import { FlightPath } from './flight.js';

function at(path: FlightPath, t: number): { width: number; travelled: number } {
  const io = Float64Array.of(0, 0, t);
  path.evaluate(io);
  return { width: io[0] ?? NaN, travelled: io[1] ?? NaN };
}

describe('van Wijk and Nuij flight path (F195)', () => {
  it('starts and ends exactly at both views', () => {
    for (const [w0, w1, u1] of [
      [2000, 3000, 9_000_000],
      [5e6, 1000, 2e6],
      [800, 800, 50_000],
    ] as const) {
      const path = new FlightPath().set(w0, w1, u1);
      const start = at(path, 0);
      const end = at(path, 1);
      expect(start.width / w0).toBeCloseTo(1, 9);
      expect(start.travelled).toBeCloseTo(0, 6);
      expect(end.width / w1).toBeCloseTo(1, 9);
      expect(end.travelled / u1).toBeCloseTo(1, 9);
    }
  });

  it('rises above both ends on a long flight, travelling monotonically', () => {
    // Milan to Tokyo at street scale: about 9,700 km between 2 km wide views.
    const path = new FlightPath().set(2000, 2000, 9.7e6);
    let previous = -1;
    let highest = 0;
    for (let i = 0; i <= 100; i++) {
      const { width, travelled } = at(path, i / 100);
      expect(travelled).toBeGreaterThanOrEqual(previous);
      previous = travelled;
      highest = Math.max(highest, width);
    }
    // The paper's optimum zooms out to see both ends at once: wider than the distance itself.
    expect(highest).toBeGreaterThan(9.7e6 / 2);
    expect(at(path, 0.5).width).toBeCloseTo(highest, -3);
  });

  it('is a pure exponential zoom when the centers coincide, in either direction', () => {
    const out = new FlightPath().set(1000, 64_000, 0);
    expect(out.length).toBeCloseTo(Math.log(64) / 1.42, 12);
    expect(at(out, 0.5).width).toBeCloseTo(8000, 6);
    const zoomIn = new FlightPath().set(64_000, 1000, 0);
    expect(at(zoomIn, 0.5).width).toBeCloseTo(8000, 6);
    expect(at(zoomIn, 1).travelled).toBe(0);
  });

  it('gives longer paths to farther flights', () => {
    const near = new FlightPath().set(2000, 2000, 100_000).length;
    const far = new FlightPath().set(2000, 2000, 9.7e6).length;
    expect(far).toBeGreaterThan(near);
    expect(near).toBeGreaterThan(0);
  });

  it('moves at a constant perceived speed: ρ²(u′/w)² + (w′/w)²/ρ² stays 1 along the path, for any ρ', () => {
    for (const rho of [1.42, 0.8, 2.5]) {
      const path = new FlightPath().set(2000, 3000, 9.7e6, rho);
      const ds = 1e-5;
      for (let i = 1; i < 20; i++) {
        const t = i / 20;
        const before = at(path, t - ds / 2);
        const after = at(path, t + ds / 2);
        const width = at(path, t).width;
        const step = ds * path.length;
        const du = (after.travelled - before.travelled) / step / width;
        const dw = (after.width - before.width) / step / width;
        expect(rho * rho * du * du + (dw * dw) / (rho * rho), `ρ ${rho} at ${t}`).toBeCloseTo(1, 4);
      }
    }
  });

  it('rises higher with a larger ρ', () => {
    const low = at(new FlightPath().set(2000, 2000, 9.7e6, 1), 0.5).width;
    const high = at(new FlightPath().set(2000, 2000, 9.7e6, 2), 0.5).width;
    expect(high).toBeGreaterThan(low);
  });
});
