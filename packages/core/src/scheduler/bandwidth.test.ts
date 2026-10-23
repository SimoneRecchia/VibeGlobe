import { describe, expect, it } from 'vitest';
import { BandwidthEstimator } from './bandwidth.js';
import type { TransportResult } from './types.js';

const response = (bytes: number, waitMs: number): Extract<TransportResult, { kind: 'ok' }> => ({
  kind: 'ok',
  bytes: new ArrayBuffer(bytes),
  contentType: 'image/png',
  waitMs,
});

/** Downloads of `bytes` each over a link of `bitsPerSecond`, `concurrency` at a time, for `durationMs`. */
function simulate(
  estimator: BandwidthEstimator,
  bitsPerSecond: number,
  bytes: number,
  concurrency: number,
  durationMs: number,
  latencyMs = 0,
): void {
  // Requests share the link: each takes the latency plus its share of the transfer time.
  const eachMs = latencyMs + ((bytes * 8) / bitsPerSecond) * 1000 * concurrency;
  for (let t = 0; t + eachMs <= durationMs; t += eachMs) {
    for (let i = 0; i < concurrency; i++) estimator.started(t);
    for (let i = 0; i < concurrency; i++) estimator.ended(t + eachMs, t, response(bytes, latencyMs));
  }
}

describe('bandwidth estimate (F300, F303)', () => {
  it('converges to the link throughput within 20% from downloads alone, at 400 kbps, 5 Mbps and 50 Mbps', () => {
    for (const bitsPerSecond of [400e3, 5e6, 50e6]) {
      const estimator = new BandwidthEstimator();
      simulate(estimator, bitsPerSecond, 20_000, 4, 10_000);
      expect(Math.abs(estimator.bitsPerSecond / bitsPerSecond - 1)).toBeLessThan(0.2);
    }
  });

  it('measures with the network times when the main thread notices responses late, and skips cache hits', () => {
    const estimator = new BandwidthEstimator();
    // 50 Mbps: 6250 bytes take 1 ms on the network, noticed 15 ms later (a busy frame).
    for (let i = 0; i < 20; i++) {
      const startMs = 100 * i;
      const result: TransportResult = { ...response(6250, 2), transferMs: 1, endAgoMs: 15 };
      estimator.ended(startMs + 18, startMs, result);
      estimator.ended(startMs + 18, startMs, { ...result, cached: true, transferMs: 0.01 });
    }
    expect(Math.abs(estimator.bitsPerSecond / 50e6 - 1)).toBeLessThan(0.2);
  });

  it('counts only network-timed responses once it has three, not main-thread-timed ones from other hosts', () => {
    const estimator = new BandwidthEstimator();
    for (let i = 0; i < 10; i++) {
      const startMs = 100 * i;
      // 50 Mbps measured by the network; a cross-origin host without timings looks 100 times slower.
      estimator.ended(startMs + 18, startMs, { ...response(6250, 2), transferMs: 1, endAgoMs: 15 });
      estimator.ended(startMs + 50, startMs, response(6250, 0));
    }
    expect(Math.abs(estimator.bitsPerSecond / 50e6 - 1)).toBeLessThan(0.2);
  });

  it('knows nothing before a few downloads, and does not count idle time', () => {
    const estimator = new BandwidthEstimator();
    expect(estimator.bitsPerSecond).toBeNaN();
    simulate(estimator, 5e6, 20_000, 2, 2000);
    const before = estimator.bitsPerSecond;
    // A pause of a minute, then the same link.
    estimator.started(62_000);
    estimator.ended(62_064, 62_000, response(20_000, 0));
    expect(Math.abs(estimator.bitsPerSecond / before - 1)).toBeLessThan(0.2);
  });

  it('measures latency, and holds a slow link to two requests per host but neither a fast nor a distant one', () => {
    const slow = new BandwidthEstimator();
    const fast = new BandwidthEstimator();
    const distant = new BandwidthEstimator();
    for (const estimator of [slow, fast, distant]) estimator.adaptive = true;
    simulate(slow, 400e3, 20_000, 2, 10_000, 20);
    simulate(fast, 50e6, 20_000, 6, 10_000, 20);
    simulate(distant, 50e6, 20_000, 6, 10_000, 500);
    expect([slow.latencyMs, distant.latencyMs]).toEqual([20, 500]);
    expect(slow.requestsPerHost()).toBe(2);
    expect(fast.requestsPerHost()).toBe(Number.POSITIVE_INFINITY);
    expect(distant.requestsPerHost()).toBe(Number.POSITIVE_INFINITY);
    // Without adaptation, hosts keep their own limits.
    const fixed = new BandwidthEstimator();
    simulate(fixed, 400e3, 20_000, 2, 10_000, 20);
    expect(fixed.requestsPerHost()).toBe(Number.POSITIVE_INFINITY);
  });
});
