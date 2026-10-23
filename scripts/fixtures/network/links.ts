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

/** Attempts of one tile (or of a health check), request start times in milliseconds, oldest first. */
export type Attempts = Readonly<Record<string, readonly number[]>>;

/** Limits of the retry analysis. */
export interface BackoffLimits {
  /** Most attempts of one tile. */
  readonly maxAttempts: number;
  /** Least gap between two health checks, ms. */
  readonly healthMinIntervalMs: number;
  /** Keys of health-check requests. */
  readonly isHealthCheck: (key: string) => boolean;
}

/** Timer slack: gaps are measured on the page's clock between request starts. */
const SLACK = 0.9;

/**
 * The violations of bounded retries with backoff, one line each (empty when none): a tile asked for more than
 * `maxAttempts` times; a retry sooner after the previous one than the first retry was after its own (the gaps between
 * retries must not shrink); health checks closer together than their minimum interval.
 */
export function backoffViolations(attempts: Attempts, limits: BackoffLimits): string[] {
  const violations: string[] = [];
  for (const [key, times] of Object.entries(attempts)) {
    const gaps = times.slice(1).map((t, i) => t - (times[i] ?? t));
    if (limits.isHealthCheck(key)) {
      for (const gap of gaps)
        if (gap < limits.healthMinIntervalMs * SLACK)
          violations.push(`${key}: health checks ${gap.toFixed(0)} ms apart (${gaps.join(', ')})`);
      continue;
    }
    if (times.length > limits.maxAttempts) violations.push(`${key}: ${String(times.length)} attempts`);
    // The first gap may be a new request for a tile that came back into view, not a retry: compare retries from the
    // second gap on.
    for (let i = 2; i < gaps.length; i++)
      if ((gaps[i] ?? 0) < (gaps[1] ?? 0) * SLACK)
        violations.push(`${key}: retry ${String(i)} came sooner than the first retry (${gaps.join(', ')} ms)`);
  }
  return violations;
}
