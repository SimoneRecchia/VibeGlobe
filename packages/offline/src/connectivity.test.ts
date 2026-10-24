import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectivityMonitor } from './connectivity.js';

afterEach(() => vi.useRealTimers());

describe('connectivity monitor', () => {
  it('checks at once when the browser says it is online again, even after its checks backed off (KB-159)', async () => {
    vi.useFakeTimers();
    let up = false;
    const probes: number[] = [];
    const monitor = new ConnectivityMonitor({
      minIntervalMs: 2000,
      maxIntervalMs: 60_000,
      enabled: () => true,
      onChange: () => undefined,
      fetch: (() => {
        probes.push(Date.now());
        return up ? Promise.resolve(new Response('tile')) : Promise.reject(new Error('down'));
      }) as typeof fetch,
    });
    monitor.addEndpoint('tiles.test', 'https://tiles.test/0/0/0.png');
    monitor.reportFailure('tiles.test');
    // Down for a minute: checks at 0, 2, 6, 14, 30 and 62 s, the next one a minute later.
    await vi.advanceTimersByTimeAsync(63_000);
    expect(monitor.state('tiles.test')).toBe('unreachable');
    const before = probes.length;
    up = true;
    monitor.checkAll();
    await vi.advanceTimersByTimeAsync(2500);
    expect(probes.length).toBeGreaterThan(before);
    expect(monitor.state('tiles.test')).toBe('reachable');
    monitor.destroy();
  });
});
