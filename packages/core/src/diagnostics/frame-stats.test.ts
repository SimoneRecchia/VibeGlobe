import { describe, expect, it } from 'vitest';
import { FrameStats } from './frame-stats.js';

describe('FrameStats', () => {
  it('reports nothing before two frames', () => {
    const stats = new FrameStats();
    stats.recordFrame(1000);
    expect(stats.lastFrameTimeMs).toBeUndefined();
    expect(stats.meanFrameTimeMs).toBeUndefined();
    expect(stats.framesPerSecond).toBeUndefined();
  });

  it('computes the last and mean frame time and the frame rate', () => {
    const stats = new FrameStats();
    for (const timestamp of [0, 10, 30, 60]) stats.recordFrame(timestamp);
    expect(stats.lastFrameTimeMs).toBe(30);
    expect(stats.meanFrameTimeMs).toBe(20);
    expect(stats.framesPerSecond).toBe(50);
  });

  it('keeps only the most recent frames', () => {
    const stats = new FrameStats(2);
    for (const timestamp of [0, 100, 110, 120]) stats.recordFrame(timestamp);
    expect(stats.meanFrameTimeMs).toBe(10);
  });

  it('ignores a timestamp that goes backwards and starts again from it', () => {
    const stats = new FrameStats();
    for (const timestamp of [100, 116, 50, 66]) stats.recordFrame(timestamp);
    expect(stats.meanFrameTimeMs).toBe(16);
  });

  it('forgets everything on reset', () => {
    const stats = new FrameStats();
    for (const timestamp of [0, 16, 32]) stats.recordFrame(timestamp);
    stats.reset();
    stats.recordFrame(500);
    expect(stats.meanFrameTimeMs).toBeUndefined();
  });

  it('rejects an invalid capacity', () => {
    expect(() => new FrameStats(0)).toThrow(RangeError);
    expect(() => new FrameStats(1.5)).toThrow(RangeError);
  });
});
