// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/** Rate limits of the network pool (F222): rings of the last request start times. */

/**
 * The window of a rate limit: a second plus a margin, because requests reach the server with uneven delays, and two
 * starts just over a second apart here can arrive within the same second there (a busy page delayed some by more than
 * 150 ms on CI: F222 counted 11 in one second at the server).
 */
const RATE_WINDOW_MS = 1250;

/** Start times of the last `maxRequestsPerSecond` requests, a ring. */
export interface RateRing {
  readonly starts: number[];
  next: number;
}

/** A rate limit's ring of its last start times. */
export function rateRing(maxRequestsPerSecond: number): RateRing {
  if (!(maxRequestsPerSecond >= 1))
    throw new RangeError(`maxRequestsPerSecond must be at least 1, got ${String(maxRequestsPerSecond)}`);
  return { starts: new Array<number>(Math.floor(maxRequestsPerSecond)).fill(-Infinity), next: 0 };
}

/** Records a request start in a rate limit's ring. */
export function recordStart(ring: RateRing | undefined, nowMs: number): void {
  if (ring === undefined) return;
  ring.starts[ring.next] = nowMs;
  ring.next = (ring.next + 1) % ring.starts.length;
}

/** Milliseconds until a request may start under the ring's limit: 0 or less when it may start now. */
export function rateWaitMs(ring: RateRing, nowMs: number): number {
  return (ring.starts[ring.next] ?? -Infinity) + RATE_WINDOW_MS - nowMs;
}
