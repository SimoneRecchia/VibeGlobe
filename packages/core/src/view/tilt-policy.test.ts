import { describe, expect, it } from 'vitest';
import { Camera } from '../camera/camera.js';
import { DEFAULT_VIEW_CURVES } from './curves.js';
import { ViewState } from './view-state.js';

const DEG = Math.PI / 180;

/** A view state with the default tilt policy (F625) and a camera, and a function that applies one frame at a range. */
function policyView(): { view: ViewState; camera: Camera; frame: (rangeMeters: number) => number } {
  const view = new ViewState(DEFAULT_VIEW_CURVES);
  view.tiltPolicy.set([20_000, 2_000, 60 * DEG, 1]);
  const camera = new Camera();
  camera.widthPx = 800;
  camera.heightPx = 600;
  let time = 0;
  const frame = (rangeMeters: number): number => {
    camera.pose.rangeMeters = rangeMeters;
    camera.update();
    time += 16;
    view.frameTimeMs[0] = time;
    view.applyTilt(camera, 0);
    return camera.pose.tiltRad / DEG;
  };
  return { view, camera, frame };
}

/** Ranges from `from` to `to` meters in steps of 2%. */
function ranges(from: number, to: number): number[] {
  const out: number[] = [];
  for (let r = from; from > to ? r >= to : r <= to; r *= from > to ? 0.98 : 1.02) out.push(r);
  return out;
}

describe('the tilt policy (F625)', () => {
  it('tilts by itself from 0° at 2,000 m to 60° at 500 m, continuously, and back to 0° rising', () => {
    const { frame } = policyView();
    const down = ranges(30_000, 300).map((r) => [r, frame(r)] as const);
    for (const [range, tilt] of down) {
      if (range >= 2_000) expect(tilt).toBe(0);
      if (range <= 500) expect(tilt).toBeCloseTo(60, 6);
    }
    const steps = down.slice(1).map(([, tilt], i) => tilt - (down[i]?.[1] ?? 0));
    expect(Math.min(...steps)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...steps)).toBeLessThan(3);
    const up = ranges(300, 30_000).map((r) => frame(r));
    expect(up.at(-1)).toBe(0);
    expect(Math.max(...up.slice(1).map((tilt, i) => (up[i] ?? 0) - tilt))).toBeLessThan(3);
  });

  it('keeps the view flat beyond 20,000 m, whatever tilt is chosen, and says tilting is unavailable', () => {
    const { view, frame } = policyView();
    view.chooseTilt(45 * DEG);
    expect(frame(30_000)).toBe(0);
    expect(view.tiltPolicy[3]).toBe(0);
    view.setMode('3d');
    expect(frame(30_000)).toBe(0);
    expect(frame(9_000)).toBeGreaterThan(0);
    expect(view.tiltPolicy[3]).toBe(1);
  });

  it('keeps a tilt chosen below the lock, and lowers it continuously to 0° as the camera rises past the lock', () => {
    const { view, frame } = policyView();
    frame(5_000);
    view.chooseTilt(45 * DEG);
    // It stays at every distance up to half the lock.
    for (const range of ranges(5_000, 10_000)) expect(frame(range)).toBeCloseTo(45, 6);
    const rising = ranges(10_000, 25_000).map((r) => frame(r));
    expect(Math.max(...rising.slice(1).map((tilt, i) => tilt - (rising[i] ?? 0)))).toBeLessThanOrEqual(0);
    expect(Math.max(...rising.slice(1).map((tilt, i) => (rising[i] ?? 0) - tilt))).toBeLessThan(5);
    expect(rising.at(-1)).toBe(0);
  });

  it("chooses the policy's tilt in 3D, and the zoom curves apply again without a policy", () => {
    const { view, frame } = policyView();
    frame(3_000);
    view.setMode('3d');
    expect(view.chosenTiltRad / DEG).toBeCloseTo(60, 9);
    view.tiltPolicy[0] = 0;
    view.setMode('auto');
    // 3,000 m on an 800 × 600 view is ground zoom ≈ 15.6, inside the default curves' tilt band.
    for (let i = 0; i < 60; i++) frame(3_000);
    expect(frame(3_000)).toBeGreaterThan(0);
    expect(frame(3_000)).toBeLessThan(DEFAULT_VIEW_CURVES.autoTiltDeg);
  });

  it('caps the tilt from 0° at the lock to 90° at fullTiltBelowMeters and reports the cap (F641, F642)', () => {
    const { view, frame } = policyView();
    // The full tilt at 6,000 m: log2(60,000 / 6,000) octaves within the lock.
    view.tiltPolicy.set([60_000, 2_000, 60 * DEG, 1, Math.log2(10), 0]);
    frame(5_000);
    view.chooseTilt(85 * DEG);
    const down = ranges(80_000, 3_000).map((r) => {
      const tilt = frame(r);
      return { range: r, tilt, cap: (view.tiltPolicy[5] ?? 0) / DEG };
    });
    for (const { range, tilt, cap } of down) {
      // At most the cap; a cap that rises releases the chosen tilt, which eases up behind it.
      expect(tilt).toBeLessThanOrEqual(cap + 1e-9);
      expect(tilt).toBeGreaterThan(Math.min(85, cap) - 2);
      if (range >= 60_000) expect(cap).toBe(0);
    }
    const at = (meters: number): number => down.find(({ range }) => range <= meters)?.cap ?? Number.NaN;
    // Halfway in the logarithm from the lock to the full tilt the cap is part way up, and it is no longer the limit
    // within 6,000 m, where the empty-sky limit alone holds it below 90°.
    expect(at(20_000)).toBeGreaterThan(20);
    expect(at(20_000)).toBeLessThan(70);
    expect(at(5_000)).toBeGreaterThan(75);
    const steps = down.slice(1).map(({ cap }, i) => cap - (down[i]?.cap ?? 0));
    expect(Math.min(...steps)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...steps)).toBeLessThan(3);
  });

  it('reports the tilt terrain clearance holds the camera at as the largest tilt (F642)', () => {
    const view = new ViewState(DEFAULT_VIEW_CURVES);
    const camera = new Camera();
    camera.widthPx = 800;
    camera.heightPx = 600;
    camera.pose.rangeMeters = 1_000;
    camera.update();
    view.chooseTilt(80 * DEG);
    view.frameTimeMs[0] = 16;
    // Without terrain the sky limit alone holds the tilt.
    view.applyTilt(camera, 0);
    const open = (view.tiltPolicy[5] ?? 0) / DEG;
    expect(open).toBeGreaterThan(60);
    // A ridge 400 m above the target under the eye, and 50 m of clearance: the eye stays above 450 m.
    camera.groundHeightMeters = 400;
    view.frameTimeMs[0] = 32;
    view.applyTilt(camera, 50);
    const held = camera.pose.tiltRad / DEG;
    expect(held).toBeLessThan(open);
    expect((view.tiltPolicy[5] ?? 0) / DEG).toBeCloseTo(held, 9);
  });
});
