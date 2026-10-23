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

  it('accept bounded retries with growing gaps and spaced health checks', () => {
    expect(backoffViolations({ a: [0, 500, 1500, 3500], health: [0, 300, 900] }, limits)).toEqual([]);
  });

  it('report endless retries, shrinking backoff and health checks too close together', () => {
    const violations = backoffViolations(
      { endless: [0, 10, 20, 30, 40, 50, 60], shrinking: [0, 100, 1000, 200 + 1000], health: [0, 100] },
      limits,
    );
    expect(violations).toHaveLength(3);
    expect(violations[0]).toMatch(/endless: 7 attempts/);
    expect(violations.some((v) => v.startsWith('shrinking: retry 2'))).toBe(true);
    expect(violations.some((v) => v.startsWith('health: health checks 100 ms apart'))).toBe(true);
  });
});
