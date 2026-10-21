import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRY_POLICY,
  FAILURE_ABORTED,
  FAILURE_CORRUPT,
  FAILURE_NONE,
  FAILURE_NO_DATA,
  FAILURE_PERMANENT,
  FAILURE_TRANSIENT,
  FAILURE_UNAUTHORIZED,
  backoffDelayMs,
  classifyDecodeFailure,
  classifyStatus,
  classifyTransportResult,
  createFailureDecision,
  decideAfterResult,
  isRateLimited,
  type RetryPolicy,
} from './failure-policy.js';
import type { TransportResult } from './types.js';

/** A small seeded generator (mulberry32), so retry times are reproducible. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function status(code: number, retryAfterMs?: number): TransportResult {
  return { kind: 'status', status: code, retryAfterMs };
}

const OK: TransportResult = { kind: 'ok', bytes: new ArrayBuffer(4), contentType: 'image/png' };

describe('classifyTransportResult', () => {
  it('classifies successes, aborts, network errors and timeouts', () => {
    expect(classifyTransportResult(OK)).toBe(FAILURE_NONE);
    expect(classifyTransportResult({ kind: 'ok', bytes: new ArrayBuffer(0), contentType: 'image/png' })).toBe(
      FAILURE_NO_DATA,
    );
    expect(classifyTransportResult({ kind: 'aborted' })).toBe(FAILURE_ABORTED);
    expect(classifyTransportResult({ kind: 'network-error' })).toBe(FAILURE_TRANSIENT);
    expect(classifyTransportResult({ kind: 'timeout' })).toBe(FAILURE_TRANSIENT);
  });

  it.each([
    [404, FAILURE_NO_DATA],
    [410, FAILURE_NO_DATA],
    [204, FAILURE_NO_DATA],
    [401, FAILURE_UNAUTHORIZED],
    [403, FAILURE_UNAUTHORIZED],
    [408, FAILURE_TRANSIENT],
    [429, FAILURE_TRANSIENT],
    [500, FAILURE_TRANSIENT],
    [502, FAILURE_TRANSIENT],
    [503, FAILURE_TRANSIENT],
    [504, FAILURE_TRANSIENT],
    [599, FAILURE_TRANSIENT],
    [501, FAILURE_PERMANENT],
    [400, FAILURE_PERMANENT],
    [405, FAILURE_PERMANENT],
    [418, FAILURE_PERMANENT],
    [451, FAILURE_PERMANENT],
    [200, FAILURE_PERMANENT],
    [304, FAILURE_PERMANENT],
    [100, FAILURE_PERMANENT],
    [600, FAILURE_PERMANENT],
  ])('status %i has class %i', (code, expected) => {
    expect(classifyStatus(code)).toBe(expected);
    expect(classifyTransportResult(status(code))).toBe(expected);
  });

  it('tells corrupt payloads from undecodable formats (plan risk 9)', () => {
    expect(classifyDecodeFailure(true)).toBe(FAILURE_CORRUPT);
    expect(classifyDecodeFailure(false)).toBe(FAILURE_NO_DATA);
  });

  it('recognizes rate limiting', () => {
    expect(isRateLimited(status(429))).toBe(true);
    expect(isRateLimited(status(503))).toBe(false);
    expect(isRateLimited({ kind: 'timeout' })).toBe(false);
  });
});

describe('backoffDelayMs', () => {
  it('doubles the ceiling per retry from 0.5 s up to 30 s', () => {
    const almostOne = (): number => 1 - 2 ** -53;
    const ceilings = [0, 1, 2, 3, 4, 5, 6, 7, 20, 2000].map((retries) => backoffDelayMs(retries, almostOne));
    const expected = [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000];
    ceilings.forEach((ceiling, i) => expect(ceiling).toBeCloseTo(expected[i] ?? 0, 6));
    expect(backoffDelayMs(3, () => 0)).toBe(0);
    expect(backoffDelayMs(1, () => 0.5)).toBe(500);
  });

  it('treats an out-of-range random source as zero', () => {
    expect(backoffDelayMs(2, () => 1)).toBe(0);
    expect(backoffDelayMs(2, () => -0.1)).toBe(0);
    expect(backoffDelayMs(2, () => Number.NaN)).toBe(0);
  });

  test.prop([fc.integer({ min: 0, max: 64 }), fc.integer()])(
    'stays inside the jitter bounds with a seeded generator',
    (retries, seed) => {
      const random = seededRandom(seed);
      for (let i = 0; i < 20; i++) {
        const delay = backoffDelayMs(retries, random);
        const ceiling = Math.min(30_000, 500 * 2 ** retries);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThan(ceiling);
      }
    },
  );

  it('spreads retries of clients that failed together', () => {
    const random = seededRandom(42);
    const delays = Array.from({ length: 200 }, () => backoffDelayMs(4, random));
    const buckets = new Set(delays.map((delay) => Math.floor(delay / 1000)));
    expect(buckets.size).toBe(8);
  });
});

describe('decideAfterResult', () => {
  it('never retries success, no data, permanent, authorization or aborted results', () => {
    const out = createFailureDecision();
    const results: TransportResult[] = [OK, status(404), status(410), status(204), status(400), status(401)];
    results.push(status(403), status(501), { kind: 'aborted' });
    for (const result of results) {
      decideAfterResult(result, 0, 1000, () => 0.5, out);
      expect(out.retry).toBe(false);
      expect(out.nextEligibleMs).toBe(1000);
    }
  });

  it('retries transient failures with the jittered backoff, 4 times at most', () => {
    const out = createFailureDecision();
    const nowMs = 10_000;
    const ceilings = [500, 1000, 2000, 4000];
    for (let retries = 0; retries < 4; retries++) {
      expect(decideAfterResult({ kind: 'timeout' }, retries, nowMs, () => 0.75, out)).toBe(out);
      expect(out.failureClass).toBe(FAILURE_TRANSIENT);
      expect(out.retry).toBe(true);
      expect(out.nextEligibleMs).toBe(nowMs + 0.75 * (ceilings[retries] ?? 0));
    }
    decideAfterResult({ kind: 'network-error' }, 4, nowMs, () => 0.75, out);
    expect(out.failureClass).toBe(FAILURE_TRANSIENT);
    expect(out.retry).toBe(false);
    expect(out.nextEligibleMs).toBe(nowMs);
  });

  it('honors Retry-After when later than the backoff, up to 60 s', () => {
    const out = createFailureDecision();
    decideAfterResult(status(429, 5000), 0, 100, () => 0.5, out);
    expect(out.nextEligibleMs).toBe(5100);
    decideAfterResult(status(503, 120_000), 0, 100, () => 0.5, out);
    expect(out.nextEligibleMs).toBe(60_100);
    // An earlier Retry-After does not shorten the backoff.
    decideAfterResult(status(503, 10), 3, 100, () => 0.5, out);
    expect(out.nextEligibleMs).toBe(2100);
    decideAfterResult(status(503, -5), 0, 100, () => 0, out);
    expect(out.nextEligibleMs).toBe(100);
    decideAfterResult(status(503, Number.NaN), 0, 100, () => 0, out);
    expect(out.nextEligibleMs).toBe(100);
    // Retry-After on a status that is not retried changes nothing.
    decideAfterResult(status(404, 5000), 0, 100, () => 0.5, out);
    expect(out.retry).toBe(false);
    expect(out.nextEligibleMs).toBe(100);
  });

  it('follows a custom policy', () => {
    const policy: RetryPolicy = { maxRetries: 1, baseDelayMs: 100, maxDelayMs: 150, maxRetryAfterMs: 120 };
    const out = createFailureDecision();
    decideAfterResult(status(500), 0, 0, () => 0.5, out, policy);
    expect(out.nextEligibleMs).toBe(50);
    decideAfterResult(status(429, 1000), 0, 0, () => 0.5, out, policy);
    expect(out.nextEligibleMs).toBe(120);
    decideAfterResult(status(500), 1, 0, () => 0.5, out, policy);
    expect(out.retry).toBe(false);
  });

  test.prop([
    fc.constantFrom<TransportResult>(
      { kind: 'timeout' },
      { kind: 'network-error' },
      status(408),
      status(429, 2500),
      status(500),
      status(503, 90_000),
    ),
    fc.integer({ min: 0, max: 10 }),
    fc.double({ min: 0, max: 1e12, noNaN: true }),
    fc.integer(),
  ])('a retry time lies in [now, now + max(ceiling, Retry-After ≤ 60 s)]', (result, retries, nowMs, seed) => {
    const out = decideAfterResult(result, retries, nowMs, seededRandom(seed), createFailureDecision());
    expect(out.retry).toBe(retries < DEFAULT_RETRY_POLICY.maxRetries);
    if (!out.retry) return;
    const retryAfterMs = result.kind === 'status' ? Math.min(result.retryAfterMs ?? 0, 60_000) : 0;
    const upperMs = Math.max(Math.min(30_000, 500 * 2 ** retries), retryAfterMs);
    expect(out.nextEligibleMs).toBeGreaterThanOrEqual(nowMs + retryAfterMs);
    expect(out.nextEligibleMs).toBeLessThanOrEqual(nowMs + upperMs);
  });

  test.prop([fc.integer({ min: 100, max: 599 }), fc.integer({ min: 0, max: 10 })])(
    'no data is never retried',
    (code, retries) => {
      const out = decideAfterResult(status(code), retries, 0, Math.random, createFailureDecision());
      if (out.failureClass === FAILURE_NO_DATA) expect(out.retry).toBe(false);
      if (out.retry) expect(out.failureClass).toBe(FAILURE_TRANSIENT);
    },
  );

  it('keeps the default policy frozen', () => {
    expect(Object.isFrozen(DEFAULT_RETRY_POLICY)).toBe(true);
  });
});
