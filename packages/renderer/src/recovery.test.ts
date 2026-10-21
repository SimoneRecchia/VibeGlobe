import { describe, expect, it } from 'vitest';
import { RecoveryLimiter, watchLoss } from './recovery.js';

describe('RecoveryLimiter (ADR 0010 §8)', () => {
  it('allows three recoveries within a minute, each after a longer pause, then gives up', () => {
    const limiter = new RecoveryLimiter();
    expect(limiter.next(0)).toBe(250);
    expect(limiter.next(1000)).toBe(500);
    expect(limiter.next(2000)).toBe(1000);
    expect(limiter.next(3000)).toBeUndefined();
    expect(limiter.recentLosses).toBe(4);
  });

  it('forgets losses older than a minute', () => {
    const limiter = new RecoveryLimiter();
    limiter.next(0);
    limiter.next(10_000);
    limiter.next(20_000);
    expect(limiter.next(90_000)).toBe(250);
  });
});

describe('watchLoss (KB-023, KB-053, KB-054)', () => {
  it('counts a device as held until it is actually lost, also after the watch stops', async () => {
    let lose: (info: { message: string; reason: string }) => void = () => undefined;
    const device = { lost: new Promise<{ message: string; reason: string }>((resolve) => (lose = resolve)) };
    const watch = watchLoss({ backend: { device } } as never, () => undefined);
    expect(watch.held()).toBe(true);
    watch.stop();
    // Stopping only stops the reports: a device nobody released is still held, so a leak shows.
    expect(watch.held()).toBe(true);
    lose({ message: 'destroyed', reason: 'destroyed' });
    await Promise.resolve();
    expect(watch.held()).toBe(false);
  });

  it('counts a WebGL2 context as held until it is lost, also after the watch stops', () => {
    let lost = false;
    const gl = { isContextLost: () => lost };
    const watch = watchLoss({ backend: { gl } } as never, () => undefined);
    watch.stop();
    expect(watch.held()).toBe(true);
    lost = true;
    expect(watch.held()).toBe(false);
  });
});

describe('watchLoss reports a loss once (KB-057)', () => {
  it('reports a real device loss once, although three.js forwards it too', async () => {
    let lose: (info: { message: string; reason: string }) => void = () => undefined;
    const device = { lost: new Promise<{ message: string; reason: string }>((resolve) => (lose = resolve)) };
    const renderer: { backend: { device: typeof device }; onDeviceLost?: (info: { message?: string }) => void } = {
      backend: { device },
    };
    // three.js 0.186 calls onDeviceLost from its own `lost` handler for every reason except 'destroyed'.
    void device.lost.then((info) => {
      if (info.reason !== 'destroyed') renderer.onDeviceLost?.(info);
    });
    const reports: string[] = [];
    watchLoss(renderer as never, (reason) => reports.push(reason));
    lose({ message: 'GPU process crashed', reason: 'unknown' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reports).toEqual(['GPU process crashed']);
  });
});
