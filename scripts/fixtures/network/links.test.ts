import { describe, expect, it } from 'vitest';
import { backoffViolations, LINKS, lanOnly } from './links.ts';

const limits = { maxAttempts: 6, healthMinIntervalMs: 300, isHealthCheck: (key: string) => key.startsWith('health') };

describe('network links', () => {
  it('drop one request in five on the flaky link, every request offline, none on the others', () => {
    const fates = (name: string) => {
      const link = LINKS.find((l) => l.name === name);
      return Array.from({ length: 100 }, (_, i) => link?.intercept(i));
    };
    expect(fates('flaky').filter((f) => f === 'reset')).toHaveLength(20);
    expect(fates('offline').every((f) => f === 'disconnected')).toBe(true);
    expect(fates('400kbps').every((f) => f === 'continue')).toBe(true);
    expect(LINKS.find((l) => l.name === '400kbps')?.rules).toEqual([{ linkBytesPerS: 50_000 }]);
  });

  it('let only the LAN host through in LAN-only mode', () => {
    expect(lanOnly(new URL('http://localhost:5173/x'), 'localhost:5173')).toBe(true);
    expect(lanOnly(new URL('https://tile.example.com/x'), 'localhost:5173')).toBe(false);
  });

  const fail = (...frames: number[]) => frames.map((frame) => ({ startMs: frame * 16, frame, failed: true }));
  const ok = (frame: number, startMs = frame * 16) => ({ startMs, frame, failed: false });

  it('accept bounded retries in later frames, re-requests after a success, and spaced health checks', () => {
    const attempts = {
      a: [...fail(0, 30, 31, 90), ok(200)],
      // Loaded, left the view, asked again in the same frame as the load: new requests, not retries.
      b: [ok(0), ok(40), ok(40)],
      health: [ok(0, 0), ok(1, 300), ok(2, 900)],
    };
    expect(backoffViolations(attempts, limits)).toEqual([]);
  });

  it('report endless retries, retries without a wait and health checks too close together', () => {
    const violations = backoffViolations(
      {
        endless: fail(0, 10, 20, 30, 40, 50, 60),
        eager: [...fail(0, 5), ok(5)],
        health: [ok(0, 0), ok(1, 100)],
      },
      limits,
    );
    expect(violations).toEqual([
      'endless: more than 6 attempts in a row',
      'eager: retry in frame 5, the frame of its failure',
      'health: health checks 100 ms apart (100)',
    ]);
  });
});
