import { describe, expect, it } from 'vitest';
import { RecoveryLimiter } from './recovery.js';

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
