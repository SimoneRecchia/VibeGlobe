// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { TransportResult } from './types.js';

/** Below this throughput a link is slow: fewer requests at once and no prefetch (F302, F303). */
export const SLOW_LINK_BPS = 1.5e6;
/** From this latency a link is distant: its throughput is bound by round trips, not by its capacity. */
const DISTANT_LINK_MS = 200;
/** Recent responses the estimate covers. */
const RECENT = 32;

/**
 * Throughput and latency measured from the engine's own downloads (F300), so bandwidth adaptation works in every
 * browser, the Network Information API or not. Throughput is the bytes of the recent responses over the time at least
 * one of them was transferring (the union of their transfers, from the headers to the last byte), so neither idle gaps
 * nor the server's time before answering dilute it; latency is the shortest recent wait for the headers (or the
 * shortest whole request when the transport does not tell).
 */
export class BandwidthEstimator {
  /** Transfers of the recent responses: start, end and bytes, in a ring. */
  private readonly from = new Float64Array(RECENT);
  private readonly to = new Float64Array(RECENT);
  private readonly sizes = new Float64Array(RECENT);
  private readonly waits = new Float64Array(RECENT).fill(Number.POSITIVE_INFINITY);
  /** 1 for a response timed by the network (Resource Timing), 0 for one timed by the main thread. */
  private readonly exact = new Uint8Array(RECENT);
  private count = 0;
  private next = 0;
  /** Measured throughput in bits per second; NaN until a few responses over enough transfer time. */
  bitsPerSecond = Number.NaN;
  /** Scratch for the union of the transfers, sorted by start. */
  private readonly order = new Float64Array(2 * RECENT);
  /** Whether {@link requestsPerHost} limits hosts to what the link supports (F303). */
  adaptive = false;

  /** A request started at `nowMs`, which it returns. */
  started(nowMs: number): number {
    return nowMs;
  }

  /** A request that started at `startMs` ended at `nowMs` with `result`: a response's bytes and wait count. */
  ended(nowMs: number, startMs: number, result: TransportResult): void {
    if (result.kind !== 'ok' || result.bytes.byteLength <= 0 || result.cached === true) return;
    const waitMs = Math.min(nowMs - startMs, Math.max(0, result.waitMs ?? 0));
    const at = this.next;
    // The network's own times when the transport has them: the main thread notices a response's end late (F300).
    const endMs = nowMs - Math.max(0, result.endAgoMs ?? 0);
    this.to[at] = endMs;
    this.from[at] = result.transferMs === undefined ? startMs + waitMs : endMs - Math.max(0, result.transferMs);
    this.sizes[at] = result.bytes.byteLength;
    this.waits[at] = result.waitMs ?? nowMs - startMs;
    this.exact[at] = result.transferMs === undefined ? 0 : 1;
    this.next = (at + 1) % RECENT;
    this.count = Math.min(RECENT, this.count + 1);
    this.bitsPerSecond = this.measure();
  }

  /** The shortest recent wait for a response's headers, milliseconds; NaN before any response. */
  get latencyMs(): number {
    let shortest = Number.POSITIVE_INFINITY;
    for (const wait of this.waits) shortest = Math.min(shortest, wait);
    return Number.isFinite(shortest) ? shortest : Number.NaN;
  }

  /**
   * Requests in flight per host the measured link supports (F303): two on a slow link (below 1.5 Mbps with a short
   * latency), so the most important tiles arrive first instead of all sharing it; otherwise each host's own limit,
   * which a fast or distant link fills. No limit until the link is measured, or without `adaptive`.
   */
  requestsPerHost(): number {
    const bitsPerSecond = this.bitsPerSecond;
    if (!this.adaptive || !Number.isFinite(bitsPerSecond)) return Number.POSITIVE_INFINITY;
    return bitsPerSecond < SLOW_LINK_BPS && !(this.latencyMs >= DISTANT_LINK_MS) ? 2 : Number.POSITIVE_INFINITY;
  }

  /**
   * The recent responses' bytes over the union of their transfer intervals. Once three responses were timed by the
   * network, only those count: the main thread notices a response's end late, more so on a busy page (F300).
   */
  private measure(): number {
    let timed = 0;
    for (let i = 0; i < this.count; i++) timed += this.exact[i] ?? 0;
    const exactOnly = timed >= 3;
    if ((exactOnly ? timed : this.count) < 3) return Number.NaN;
    // Sort the transfers by start (insertion sort of indices; at most 32).
    const order = this.order;
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      if (exactOnly && this.exact[i] === 0) continue;
      let j = n++;
      while (j > 0 && (this.from[order[j - 1] ?? 0] ?? 0) > (this.from[i] ?? 0)) {
        order[j] = order[j - 1] ?? 0;
        j--;
      }
      order[j] = i;
    }
    const delayMs = this.fixedDelayMs(order, n);
    let unionMs = 0;
    let bytes = 0;
    let end = Number.NEGATIVE_INFINITY;
    for (let k = 0; k < n; k++) {
      const i = order[k] ?? 0;
      const stopAt = this.to[i] ?? 0;
      const start = Math.min(stopAt, (this.from[i] ?? 0) + delayMs);
      const stop = stopAt;
      bytes += this.sizes[i] ?? 0;
      if (stop <= end) continue;
      unionMs += stop - Math.max(start, end);
      end = stop;
    }
    // 10 ms of transfers: a fast link moves small tiles in about a millisecond each (F300).
    return unionMs >= 10 ? (bytes * 8000) / unionMs : Number.NaN;
  }

  /**
   * The part of each transfer that does not grow with its bytes (KB-138): the intercept of the transfers' times fitted
   * against their sizes, time = delay + bytes ÷ throughput, at most what leaves every transfer its fitted size term. A server that
   * spends a fixed time on every response, or a busy page that notices each end a little late, then no longer reads as
   * a slow link; on a link that is the bottleneck the intercept is close to zero and nothing changes. Sizes too alike
   * to fit leave it at zero.
   */
  private fixedDelayMs(order: Float64Array, n: number): number {
    let meanBytes = 0;
    let meanMs = 0;
    for (let k = 0; k < n; k++) {
      const i = order[k] ?? 0;
      const ms = (this.to[i] ?? 0) - (this.from[i] ?? 0);
      meanBytes += this.sizes[i] ?? 0;
      meanMs += ms;
    }
    meanBytes /= n;
    meanMs /= n;
    let covariance = 0;
    let variance = 0;
    for (let k = 0; k < n; k++) {
      const i = order[k] ?? 0;
      const dx = (this.sizes[i] ?? 0) - meanBytes;
      covariance += dx * ((this.to[i] ?? 0) - (this.from[i] ?? 0) - meanMs);
      variance += dx * dx;
    }
    // Sizes within a few percent of each other: the delay cannot be told from the bandwidth.
    if (variance <= (0.05 * meanBytes) ** 2 * n || covariance <= 0) return 0;
    const msPerByte = covariance / variance;
    const intercept = meanMs - msPerByte * meanBytes;
    if (intercept <= 0) return 0;
    // No transfer may keep less than its fitted size term.
    let delayMs = intercept;
    for (let k = 0; k < n; k++) {
      const i = order[k] ?? 0;
      const ms = (this.to[i] ?? 0) - (this.from[i] ?? 0);
      delayMs = Math.min(delayMs, ms - msPerByte * (this.sizes[i] ?? 0));
    }
    return Math.max(0, delayMs);
  }
}
