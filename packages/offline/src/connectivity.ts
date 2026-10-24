import { looksLikePortal } from './network-fetch.js';
import type { Connectivity } from './types.js';

/** Timing of the health checks (F297). */
export interface HealthCheckTiming {
  /** Least time between two checks of one endpoint (default 2 s): never more than one check per endpoint per interval. */
  readonly minIntervalMs?: number;
  /** Longest wait between checks while an endpoint stays unreachable (default 60 s); the wait doubles up to it. */
  readonly maxIntervalMs?: number;
  /** Time limit of one check (default 5 s). */
  readonly timeoutMs?: number;
}

/** Options of {@link ConnectivityMonitor}. */
export interface ConnectivityOptions extends HealthCheckTiming {
  readonly fetch?: typeof fetch;
  /** False while health checks must not run (offline-only mode never touches the network, F292). */
  readonly enabled: () => boolean;
  /** Called when the overall connectivity changes. */
  readonly onChange: (connectivity: Connectivity, unreachable: readonly string[]) => void;
  /** Called after every check, whether or not it changed the state. */
  readonly onCheck?: () => void;
}

/** The reachability of one endpoint. */
export type EndpointState = 'reachable' | 'unreachable';

interface Endpoint {
  readonly probeUrl: string;
  state: EndpointState;
  lastCheckMs: number;
  waitMs: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** When the pending check runs. */
  dueMs: number;
  checking: boolean;
}

/** The endpoint of a tile URL: its origin. */
export function endpointOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Tracks which tile endpoints are reachable from health checks against the endpoints themselves (F297), not from
 * `navigator.onLine` alone: a check fetches a known tile and counts a redirect, an HTML page (a captive portal), a
 * server error or no answer as unreachable. Failed tile requests trigger a check; while an endpoint is unreachable the
 * checks back off up to `maxIntervalMs`. The browser's online and offline events only trigger checks.
 */
export class ConnectivityMonitor {
  private readonly endpoints = new Map<string, Endpoint>();
  private readonly minIntervalMs: number;
  private readonly maxIntervalMs: number;
  private current: Connectivity = 'online';
  private destroyed = false;
  private readonly onOnline = (): void => this.checkAll();
  private readonly onOffline = (): void => {
    for (const [name, endpoint] of this.endpoints) this.mark(name, endpoint, 'unreachable');
  };

  constructor(private readonly options: ConnectivityOptions) {
    this.minIntervalMs = options.minIntervalMs ?? 2000;
    this.maxIntervalMs = options.maxIntervalMs ?? 60_000;
    globalThis.addEventListener?.('online', this.onOnline);
    globalThis.addEventListener?.('offline', this.onOffline);
  }

  /** The overall connectivity. */
  get connectivity(): Connectivity {
    return this.current;
  }

  /** Registers an endpoint with the URL of a tile it always serves, used for its health checks. */
  addEndpoint(endpoint: string, probeUrl: string): void {
    if (this.endpoints.has(endpoint)) return;
    this.endpoints.set(endpoint, {
      probeUrl,
      state: 'reachable',
      lastCheckMs: Number.NEGATIVE_INFINITY,
      waitMs: this.minIntervalMs,
      timer: undefined,
      dueMs: Number.POSITIVE_INFINITY,
      checking: false,
    });
  }

  /** The state of an endpoint; endpoints never seen count as reachable. */
  state(endpoint: string): EndpointState {
    return this.endpoints.get(endpoint)?.state ?? 'reachable';
  }

  /** Endpoints currently unreachable. */
  unreachable(): string[] {
    return [...this.endpoints].filter(([, e]) => e.state === 'unreachable').map(([name]) => name);
  }

  /** A tile request reached the endpoint and got a real answer. */
  reportSuccess(endpoint: string): void {
    const entry = this.endpoints.get(endpoint);
    if (entry && entry.state === 'unreachable') this.mark(endpoint, entry, 'reachable');
  }

  /** A tile request got no usable answer: check the endpoint (at most once per interval). */
  reportFailure(endpoint: string): void {
    const entry = this.endpoints.get(endpoint);
    if (!entry || entry.state === 'unreachable') return;
    this.schedule(endpoint, entry, 0);
  }

  /** Checks every endpoint now, within the per-endpoint interval (also after the browser reports it is online). */
  checkAll(): void {
    for (const [name, entry] of this.endpoints) this.schedule(name, entry, 0);
  }

  /** Stops every pending check. */
  destroy(): void {
    this.destroyed = true;
    for (const entry of this.endpoints.values()) clearTimeout(entry.timer);
    globalThis.removeEventListener?.('online', this.onOnline);
    globalThis.removeEventListener?.('offline', this.onOffline);
  }

  /** Time limit of one check. */
  get timeoutMs(): number {
    return this.options.timeoutMs ?? 5000;
  }

  private schedule(name: string, entry: Endpoint, delayMs: number): void {
    if (this.destroyed || entry.checking || !this.options.enabled()) return;
    const earliest = entry.lastCheckMs + this.minIntervalMs - Date.now();
    const wait = Math.max(delayMs, earliest, 0);
    // A pending check stays unless this one is due sooner (KB-159: an online event brings a backed-off check forward).
    if (entry.timer !== undefined && entry.dueMs <= Date.now() + wait) return;
    clearTimeout(entry.timer);
    entry.dueMs = Date.now() + wait;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.check(name, entry);
    }, wait);
  }

  private async check(name: string, entry: Endpoint): Promise<void> {
    if (this.destroyed || !this.options.enabled()) return;
    entry.checking = true;
    entry.lastCheckMs = Date.now();
    const reachable = await this.probe(entry.probeUrl);
    entry.checking = false;
    if (this.destroyed) return;
    this.mark(name, entry, reachable ? 'reachable' : 'unreachable');
    this.options.onCheck?.();
    if (!reachable) {
      // Back off while the endpoint stays down: 2 s, 4 s, … up to the maximum.
      this.schedule(name, entry, entry.waitMs);
      entry.waitMs = Math.min(entry.waitMs * 2, this.maxIntervalMs);
    }
  }

  private async probe(url: string): Promise<boolean> {
    const fetchImpl = this.options.fetch ?? ((input, init) => fetch(input, init));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
      });
      await response.arrayBuffer().catch(() => undefined);
      return !looksLikePortal(response) && response.status < 500;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private mark(name: string, entry: Endpoint, state: EndpointState): void {
    if (state === 'reachable') entry.waitMs = this.minIntervalMs;
    if (entry.state === state) return;
    entry.state = state;
    if (state === 'unreachable') this.schedule(name, entry, entry.waitMs);
    const down = this.unreachable();
    const next: Connectivity =
      down.length === 0 ? 'online' : down.length === this.endpoints.size ? 'offline' : 'degraded';
    if (next === this.current) return;
    this.current = next;
    this.options.onChange(next, down);
  }
}
