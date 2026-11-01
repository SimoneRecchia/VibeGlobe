// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Failure classes and retry rules of ADR 0007 (§Failures and timeouts; docs/internal/plan/m3-imagery-streaming.md §3): which
 * transport results mean no data, which are worth a retry and when, and which are final. Classes are small integers so
 * the scheduler can keep them in its typed-array tile table; decisions are written into a caller-owned object.
 */
import type { TransportResult } from './types.js';

/** Bytes arrived. */
export const FAILURE_NONE = 0;
/** No data, terminal: 404, 410, 204, an empty body, out of coverage or levels, a format the browser cannot decode. */
export const FAILURE_NO_DATA = 1;
/** Transient: 408, 429, 5xx except 501, network errors and timeouts; retried with backoff while wanted. */
export const FAILURE_TRANSIENT = 2;
/** Permanent: any other status (other 4xx, 501, unexpected 1xx, 2xx or 3xx); never retried. */
export const FAILURE_PERMANENT = 3;
/** Authorization (401, 403): no tile retry; the source may refresh its credentials and reload. */
export const FAILURE_UNAUTHORIZED = 4;
/** A payload of a declared format that fails to decode: quarantined, never retried. */
export const FAILURE_CORRUPT = 5;
/** The request was aborted because nobody wanted it any more: not a failure, the tile returns to `unloaded`. */
export const FAILURE_ABORTED = 6;

/** One of the `FAILURE_*` classes. */
export type FailureClass = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Retry rules; {@link DEFAULT_RETRY_POLICY} holds ADR 0007's values. */
export interface RetryPolicy {
  /** Retries after the first attempt; a tile whose last allowed retry fails is `failed`. */
  readonly maxRetries: number;
  /** Ceiling of the first retry's random delay; each further retry doubles it. */
  readonly baseDelayMs: number;
  /** Largest ceiling of the random delay. */
  readonly maxDelayMs: number;
  /** Largest `Retry-After` honored; longer values are clamped to it. */
  readonly maxRetryAfterMs: number;
}

/** ADR 0007: 4 retries, delay drawn from [0, min(30 s, 0.5 s × 2^retry)), `Retry-After` honored up to 60 s. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxRetries: 4,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  maxRetryAfterMs: 60_000,
});

/** What to do after a request settled, written by {@link decideAfterResult} into an object the caller reuses. */
export interface FailureDecision {
  /** The class of the result. */
  failureClass: FailureClass;
  /** True when the tile may be requested again from {@link FailureDecision.nextEligibleMs} on, while still wanted. */
  retry: boolean;
  /** Engine-clock time of the earliest retry; equals the `nowMs` passed in when no retry follows. */
  nextEligibleMs: number;
}

/** A fresh decision object to reuse across calls. */
export function createFailureDecision(): FailureDecision {
  return { failureClass: FAILURE_NONE, retry: false, nextEligibleMs: 0 };
}

/** The class of an HTTP status delivered as a `status` result (a body-carrying success arrives as `ok`). */
export function classifyStatus(status: number): FailureClass {
  if (status === 404 || status === 410 || status === 204) return FAILURE_NO_DATA;
  if (status === 401 || status === 403) return FAILURE_UNAUTHORIZED;
  if (status === 408 || status === 429) return FAILURE_TRANSIENT;
  if (status >= 500 && status <= 599 && status !== 501) return FAILURE_TRANSIENT;
  return FAILURE_PERMANENT;
}

/** The class of a transport result. An `ok` result with an empty body is no data, like an empty 204. */
export function classifyTransportResult(result: TransportResult): FailureClass {
  switch (result.kind) {
    case 'ok':
      return result.bytes.byteLength === 0 ? FAILURE_NO_DATA : FAILURE_NONE;
    case 'status':
      return classifyStatus(result.status);
    case 'network-error':
      // Without CORS headers the browser never hands over the bytes: retrying cannot help (F251).
      return result.cause === 'cors' ? FAILURE_PERMANENT : FAILURE_TRANSIENT;
    case 'timeout':
      return FAILURE_TRANSIENT;
    case 'aborted':
      return FAILURE_ABORTED;
  }
}

/**
 * The class of a payload the decoder rejected (docs/internal/plan/m3-imagery-streaming.md §5, risk 9): bytes of a format the
 * source declared are corrupt; a content type it did not declare, or a format the browser cannot decode, is no data.
 */
export function classifyDecodeFailure(formatDeclaredAndSupported: boolean): FailureClass {
  return formatDeclaredAndSupported ? FAILURE_CORRUPT : FAILURE_NO_DATA;
}

/**
 * The random delay before retry number `retriesDone + 1`: uniform in [0, min(maxDelayMs, baseDelayMs × 2^retriesDone))
 * ("full jitter"), so clients that failed together do not retry together.
 *
 * @param random - Returns a number in [0, 1); `Math.random` in the engine, a seeded generator in tests.
 */
export function backoffDelayMs(
  retriesDone: number,
  random: () => number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): number {
  let ceilingMs = policy.baseDelayMs;
  for (let i = 0; i < retriesDone && ceilingMs < policy.maxDelayMs; i++) ceilingMs *= 2;
  if (ceilingMs > policy.maxDelayMs) ceilingMs = policy.maxDelayMs;
  const sample = random();
  // A generator returning 1 or more (or NaN) would put the delay outside its bounds.
  const unit = sample >= 0 && sample < 1 ? sample : 0;
  return unit * ceilingMs;
}

/**
 * Classifies a settled request and, for a transient failure with retries left, sets the time of the next attempt:
 * `nowMs` plus the jittered backoff, or plus `Retry-After` (clamped to the policy's maximum) when that is later.
 * Whether the tile is still wanted when that time comes is the scheduler's check (ADR 0007: the backoff is an
 * eligibility gate, not a timer). Runs once per settled request, not per frame; it allocates nothing.
 *
 * @param retriesDone - Retries already made for this tile: 0 after the first request fails.
 * @param out - Receives the decision; returned for convenience.
 */
export function decideAfterResult(
  result: TransportResult,
  retriesDone: number,
  nowMs: number,
  random: () => number,
  out: FailureDecision,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): FailureDecision {
  const failureClass = classifyTransportResult(result);
  out.failureClass = failureClass;
  out.retry = false;
  out.nextEligibleMs = nowMs;
  if (failureClass !== FAILURE_TRANSIENT || retriesDone >= policy.maxRetries) return out;
  let delayMs = backoffDelayMs(retriesDone, random, policy);
  // NaN and values below the backoff fail the first comparison and are ignored.
  if (result.kind === 'status' && result.retryAfterMs !== undefined && result.retryAfterMs > delayMs) {
    const retryAfterMs = result.retryAfterMs < policy.maxRetryAfterMs ? result.retryAfterMs : policy.maxRetryAfterMs;
    if (retryAfterMs > delayMs) delayMs = retryAfterMs;
  }
  out.retry = true;
  out.nextEligibleMs = nowMs + delayMs;
  return out;
}

/** True for a 429 response, which halves the host's concurrency limit (ADR 0007). */
export function isRateLimited(result: TransportResult): boolean {
  return result.kind === 'status' && result.status === 429;
}
