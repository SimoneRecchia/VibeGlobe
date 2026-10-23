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
  private count = 0;
  private next = 0;
  private estimate = Number.NaN;
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
    if (result.kind !== 'ok' || result.bytes.byteLength <= 0) return;
    const waitMs = Math.min(nowMs - startMs, Math.max(0, result.waitMs ?? 0));
    const at = this.next;
    this.from[at] = startMs + waitMs;
    this.to[at] = nowMs;
    this.sizes[at] = result.bytes.byteLength;
    this.waits[at] = result.waitMs ?? nowMs - startMs;
    this.next = (at + 1) % RECENT;
    this.count = Math.min(RECENT, this.count + 1);
    this.estimate = this.measure();
  }

  /** Measured throughput in bits per second; NaN until a few responses over enough transfer time. */
  get bitsPerSecond(): number {
    return this.estimate;
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

  /** The recent responses' bytes over the union of their transfer intervals. */
  private measure(): number {
    if (this.count < 3) return Number.NaN;
    // Sort the transfers by start (insertion sort of indices; at most 32).
    const order = this.order;
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      let j = n++;
      while (j > 0 && (this.from[order[j - 1] ?? 0] ?? 0) > (this.from[i] ?? 0)) {
        order[j] = order[j - 1] ?? 0;
        j--;
      }
      order[j] = i;
    }
    let unionMs = 0;
    let bytes = 0;
    let end = Number.NEGATIVE_INFINITY;
    for (let k = 0; k < n; k++) {
      const i = order[k] ?? 0;
      const start = this.from[i] ?? 0;
      const stop = this.to[i] ?? 0;
      bytes += this.sizes[i] ?? 0;
      if (stop <= end) continue;
      unionMs += stop - Math.max(start, end);
      end = stop;
    }
    return unionMs >= 50 ? (bytes * 8000) / unionMs : Number.NaN;
  }
}
