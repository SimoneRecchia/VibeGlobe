import { expect, test } from '@playwright/test';

// ADR 0004 and 0005's GPU readback probes on every depth path: eye-relative vertices read back from an rgba32float
// target against float64, the reassociation canary, and depth reconstructed from a float depth texture. The results
// are printed, so the hardware run records them per device (docs/internal/hardware-testing.md).

const PATHS = [
  { name: 'webgpu', query: 'backend=webgpu', depthPath: 'reversed-z' },
  { name: 'webgl2', query: 'backend=webgl2', depthPath: 'reversed-z' },
  { name: 'webgl2 with fragment depth', query: 'backend=webgl2&depth=fragment', depthPath: 'fragment' },
] as const;

for (const path of PATHS) {
  test(`the GPU places vertices within 0.01 px and reconstructs depth within 1e-6·d on ${path.name} (ADR 0004, 0005)`, async ({
    page,
  }, testInfo) => {
    await page.goto(`/?experiment=gpu-probes&${path.query}`);
    await page.waitForFunction(() => window.vibeglobeGpuProbes !== undefined, null, { timeout: 60_000 });
    const result = await page.evaluate(() => window.vibeglobeGpuProbes);
    if (!result) throw new Error('no probe result');
    console.log(`gpu probes ${path.name}: ${JSON.stringify(result)}`);
    await testInfo.attach(`gpu-probes-${path.name}.json`, {
      body: JSON.stringify(result, null, 2),
      contentType: 'application/json',
    });
    if ('error' in result) throw new Error(result.error);
    expect(result.depthPath).toBe(path.depthPath);
    // Every tracked vertex was drawn, within the unit tests' thresholds (ADR 0004 §Verification).
    expect(result.precision.missing).toBe(0);
    expect(result.precision.maxErrorPx).toBeLessThan(0.01);
    expect(result.precision.maxErrorWithoutLowPx).toBeLessThan(0.4);
    // The probe sees a lost T_lo: the KB-025 case moves by more than 0.1 px without it.
    expect(result.precision.lowPartCaseWithoutLowPx).toBeGreaterThan(0.1);
    // The compiler keeps (offset + T_hi) + T_lo in order.
    expect(result.reassociation).toEqual({ value: 0, inOrder: true });
    // Planes from 0.12 m to 4e7 m: d = near / z within 1e-6·d (ADR 0005 §Verification).
    expect(result.depth.missing).toBe(0);
    expect(result.depth.maxRelativeError).toBeLessThan(1e-6);
  });
}
