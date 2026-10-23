// The simulated links of the network simulation suite (F315, F329): what the fixture server does to a session's
// tiles (its fault rules) and what the browser side does to each request (drop, reset or no network at all), and the
// analysis of the attempts a page made for each tile (bounded retries, backoff).
import type { FaultRule } from '../tiles/server.ts';

/** What happens to one request on its way to the fixture server. */
export type Interception = 'continue' | 'reset' | 'disconnected';

/** A simulated link. */
export interface NetworkLink {
  /** Short name, used in test titles and fixture session ids. */
  readonly name: string;
  /** The fixture server's fault rules for the session (latency, the shared link's bandwidth). */
  readonly rules: readonly FaultRule[];
  /** The fate of the `index`-th tile request of the session (0-based, in the order the page made them). */
  intercept(index: number): Interception;
}

/** 400 kbps in bytes per second. */
const KBPS_400 = 400_000 / 8;

/**
 * The links of F315: fully offline, 400 kbps shared by every response, flaky (one request in five reset, a fixed
 * pattern so a failure reproduces), 500 ms latency. LAN-only mode is a setup (packages from a LAN server, every other
 * host unreachable), not a link: `lanOnly` below.
 */
export const LINKS: readonly NetworkLink[] = [
  { name: 'offline', rules: [], intercept: () => 'disconnected' },
  { name: '400kbps', rules: [{ linkBytesPerS: KBPS_400 }], intercept: () => 'continue' },
  { name: 'flaky', rules: [{ latencyMs: 30 }], intercept: (index) => (index % 5 === 2 ? 'reset' : 'continue') },
  { name: 'latency500ms', rules: [{ latencyMs: 500 }], intercept: () => 'continue' },
];

/** Whether a request to `url` may leave the machine in LAN-only mode: only the LAN host (here the page's own). */
export function lanOnly(url: URL, lanHost: string): boolean {
  return url.host === lanHost;
}

/** One request of a tile: when it started (page time, ms), the globe's frame then, and whether the link failed it. */
export interface Attempt {
  readonly startMs: number;
  readonly frame: number;
  readonly failed: boolean;
}

/** The attempts of each tile (or health check), oldest first. */
export type Attempts = Readonly<Record<string, readonly Attempt[]>>;

/** Limits of the retry analysis. */
export interface BackoffLimits {
  /** Most attempts of one tile in a row of failures, the one that ends it included: 1 + the retry policy's retries. */
  readonly maxAttempts: number;
  /** Least gap between two health checks, ms. */
  readonly healthMinIntervalMs: number;
  /** Keys of health-check requests. */
  readonly isHealthCheck: (key: string) => boolean;
}

/** Timer slack of the health-check interval. */
const SLACK = 0.9;

/**
 * The violations of bounded retries with backoff, one line each (empty when none). A retry is a request that follows a
 * failed one of the same tile; a request after a success or a cancellation is a new one (the tile came back into
 * view). The engine's backoff (ADR 0007) is a random delay under a doubling ceiling, checked as an eligibility gate
 * every frame, so single waits may shrink: what holds for every retry is that it starts in a later frame than the
 * failure. Violations: a row of failures longer than `maxAttempts`; a retry in the frame of its failure; health checks
 * closer together than their minimum interval.
 */
export function backoffViolations(attempts: Attempts, limits: BackoffLimits): string[] {
  const violations: string[] = [];
  for (const [key, list] of Object.entries(attempts)) {
    if (limits.isHealthCheck(key)) {
      const gaps = list.slice(1).map((a, i) => a.startMs - (list[i]?.startMs ?? a.startMs));
      for (const gap of gaps)
        if (gap < limits.healthMinIntervalMs * SLACK)
          violations.push(`${key}: health checks ${gap.toFixed(0)} ms apart (${gaps.map(Math.round).join(', ')})`);
      continue;
    }
    let row = 0;
    for (const [i, attempt] of list.entries()) {
      const before = list[i - 1];
      if (before?.failed && attempt.frame <= before.frame)
        violations.push(`${key}: retry in frame ${String(attempt.frame)}, the frame of its failure`);
      row = before?.failed ? row + 1 : 1;
      if (row === limits.maxAttempts + 1)
        violations.push(`${key}: more than ${String(limits.maxAttempts)} attempts in a row`);
    }
  }
  return violations;
}
