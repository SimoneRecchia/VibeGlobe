/**
 * The page-wide network pool of ADR 0007: it owns host slots, so per-host and overall limits hold across engine
 * instances and sources (F089); coalesces concurrent needs for one tile into one transport request (F095); aborts a
 * request only when no consumer has wanted it for the abort grace period (F090); passes timeouts to the transport and
 * enforces them as a last resort (F092); and refills a freed slot at once from the best queued request of its clients.
 *
 * The pool keeps no queue: a client (one tile scheduler per engine instance) asks for a slot with
 * {@link NetworkPool.request} and keeps the record queued when it gets {@link NO_SLOT}. When a slot frees, the pool asks
 * every client for its best queued priority on that host and grants the slot to the lowest (ADR 0007 §Structure).
 *
 * Every exit path of a request (success, failure, timeout, abort, a throwing transport or consumer, disposal) releases
 * its slot exactly once, in {@link NetworkPool} itself: consumers never touch the counters.
 */
import { FAILURE_ABORTED, FAILURE_TRANSIENT, classifyTransportResult, isRateLimited } from './failure-policy.js';
import { BandwidthEstimator } from './bandwidth.js';
import { rateRing, rateWaitMs, recordStart, type RateRing } from './rate-ring.js';
import type { AbortHandle, TileRequest, TileTransport, TimeoutsMs, TransportResult } from './types.js';

/** Coalescing key of a request: source registration, tile key and variant, as a string or an exact number. */
export type RequestKey = string | number;

/** Receives the result of a request a consumer attached to; called at most once per consumer. */
export type RequestConsumer = (result: TransportResult) => void;

/** Returned by {@link NetworkPool.request} when neither a host slot nor an in-flight request was available. */
export const NO_SLOT = -1;

/** Requests in flight to one HTTP/1.1 host (ADR 0007). */
const DEFAULT_HOST_MAX_IN_FLIGHT = 6;
/** Requests in flight to one HTTP/2 or HTTP/3 host. */
const DEFAULT_MULTIPLEXED_HOST_MAX_IN_FLIGHT = 16;
/** Requests in flight overall. */
const DEFAULT_MAX_IN_FLIGHT = 32;
/** Time a request nobody wants any more keeps running before it is aborted. */
const DEFAULT_ABORT_GRACE_MS = 100;
/** Time past the total timeout after which the pool aborts a request the transport did not end (ADR 0007 watchdog). */
const DEFAULT_TIMEOUT_SLACK_MS = 1000;
/** ADR 0007: 10 s to the response headers, 30 s in total. */
export const DEFAULT_TIMEOUTS_MS: TimeoutsMs = Object.freeze({ firstByteMs: 10_000, totalMs: 30_000 });
/** Consecutive transient failures after which a host gets a single probe request until one succeeds. */
const PROBE_AFTER_TRANSIENT_FAILURES = 5;
/** Responses after a 429 that grow a halved host limit back by one. */
const RECOVERY_RESPONSES = 20;

/** Settings of one host. */
export interface HostOptions {
  /** Requests in flight at once; defaults to 6, or 16 when `multiplexed`. */
  readonly maxInFlight?: number;
  /** The host speaks HTTP/2 or HTTP/3. */
  readonly multiplexed?: boolean;
  /** Requests started per second at most, over any one-second window (a source's declared rate limit, F222). */
  readonly maxRequestsPerSecond?: number;
}

/** A client of the pool: one tile scheduler, which keeps its own priority queue. */
export interface NetworkPoolClient {
  /** The priority key of the client's best queued request for a host, or `Infinity` when none waits. */
  bestQueuedPriority(hostIndex: number): number;
  /**
   * A slot on the host is free: the client calls {@link NetworkPool.request} for its best queued request there.
   * Returns false when it started nothing.
   */
  grant(hostIndex: number): boolean;
}

/** Cumulative counters, updated in place (ADR 0007 §Observability). */
export interface NetworkPoolCounters {
  /** Requests in flight on all hosts. */
  inFlight: number;
  /** Transport requests started. */
  started: number;
  /** Requests that ended with a response, an error or a timeout (not aborted). */
  completed: number;
  /** Requests aborted because no consumer wanted them any more, or disposed. */
  aborted: number;
  /** Consumers attached to a request already in flight instead of starting one. */
  coalesced: number;
  /** Requests that timed out, reported by the transport or enforced by the pool. */
  timedOut: number;
  /** 429 responses, each of which halved its host's limit. */
  rateLimited: number;
}

/** Construction options: the clock and timers are injected, so tests are deterministic and core stays DOM-free. */
export interface NetworkPoolOptions {
  /** Monotonic time in milliseconds (`performance.now` in browsers). */
  readonly now: () => number;
  /** Calls `callback` once after `delayMs` (`setTimeout`). */
  readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  /** Cancels a timer from `setTimer` (`clearTimeout`). */
  readonly clearTimer: (handle: unknown) => void;
  /** Runs `callback` after the current task (`queueMicrotask`); defaults to a resolved promise. */
  readonly queueTask?: (callback: () => void) => void;
  /** Requests in flight overall; default {@link DEFAULT_MAX_IN_FLIGHT}. */
  readonly maxInFlight?: number;
  /** Default {@link DEFAULT_ABORT_GRACE_MS}. */
  readonly abortGraceMs?: number;
  /** Default {@link DEFAULT_TIMEOUT_SLACK_MS}. */
  readonly timeoutSlackMs?: number;
  /** Timeouts of requests that do not pass their own; default {@link DEFAULT_TIMEOUTS_MS}. */
  readonly timeouts?: TimeoutsMs;
  /** Receives the bytes of a request that completed while nobody wanted it, so they can enter the RAM tier. */
  readonly onUnclaimedResult?: (key: RequestKey, result: TransportResult) => void;
  /** Hosts get only the requests in flight the measured link supports, within their limits (F303). */
  readonly adaptive?: boolean;
}

interface Host {
  readonly origin: string;
  /** Configured limit. */
  baseLimit: number;
  /** Limit after 429 halving; grows back to `baseLimit`. */
  throttledLimit: number;
  inFlight: number;
  consecutiveTransient: number;
  responsesSinceThrottle: number;
  /** The host's own rate limit (a provider cap on the whole host), or undefined. */
  rate: RateRing | undefined;
}

interface Flight {
  readonly key: RequestKey;
  readonly host: Host;
  readonly consumerIds: number[];
  readonly consumers: RequestConsumer[];
  abort: AbortHandle | undefined;
  settled: boolean;
  aborting: boolean;
  unwantedSinceMs: number;
  graceTimer: unknown;
  safetyTimer: unknown;
  readonly startMs: number;
}

const NO_TIMER: unknown = undefined;

/** Page-wide request dispatch over tile transports; see the module documentation. */
export class NetworkPool {
  /** Cumulative counters, read by diagnostics. */
  readonly counters: NetworkPoolCounters = {
    inFlight: 0,
    started: 0,
    completed: 0,
    aborted: 0,
    coalesced: 0,
    timedOut: 0,
    rateLimited: 0,
  };
  private readonly options: NetworkPoolOptions;
  private readonly maxInFlight: number;
  private readonly abortGraceMs: number;
  private readonly timeoutSlackMs: number;
  private readonly defaultTimeouts: TimeoutsMs;
  private readonly queueTask: (callback: () => void) => void;
  private readonly hosts: Host[] = [];
  private readonly hostIndices = new Map<string, number>();
  private readonly rates: RateRing[] = [];
  private readonly flights = new Map<RequestKey, Flight>();
  private readonly consumerFlights = new Map<number, Flight>();
  private readonly clients: NetworkPoolClient[] = [];
  private nextConsumerId = 1;
  private refillPending = false;
  private rateTimerArmed = false;
  private disposed = false;
  /** Throughput and latency of the pool's downloads (F300). */
  readonly bandwidth = new BandwidthEstimator();

  constructor(options: NetworkPoolOptions) {
    this.options = options;
    this.maxInFlight = positiveInteger(options.maxInFlight, DEFAULT_MAX_IN_FLIGHT, 'maxInFlight');
    this.abortGraceMs = options.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
    this.timeoutSlackMs = options.timeoutSlackMs ?? DEFAULT_TIMEOUT_SLACK_MS;
    this.defaultTimeouts = options.timeouts ?? DEFAULT_TIMEOUTS_MS;
    this.queueTask = options.queueTask ?? ((callback) => void Promise.resolve().then(callback));
    this.bandwidth.adaptive = options.adaptive === true;
  }

  /**
   * The index of a host (an origin such as `https://a.tile.example`), registering it on first use. Registering an
   * origin again keeps the lower limit, so a provider profile's cap holds whatever another source declares.
   */
  registerHost(origin: string, options: HostOptions = {}): number {
    const fallback = options.multiplexed === true ? DEFAULT_MULTIPLEXED_HOST_MAX_IN_FLIGHT : DEFAULT_HOST_MAX_IN_FLIGHT;
    const limit = positiveInteger(options.maxInFlight, fallback, 'maxInFlight');
    const rate = options.maxRequestsPerSecond;
    const known = this.hostIndices.get(origin);
    if (known !== undefined) {
      const host = this.hosts[known] as Host;
      if (limit < host.baseLimit) this.setHostLimit(known, limit);
      if (rate !== undefined && (host.rate === undefined || rate < host.rate.starts.length)) host.rate = rateRing(rate);
      return known;
    }
    const index = this.hosts.length;
    this.hosts.push({
      origin,
      baseLimit: limit,
      throttledLimit: limit,
      inFlight: 0,
      consecutiveTransient: 0,
      responsesSinceThrottle: 0,
      rate: rate === undefined ? undefined : rateRing(rate),
    });
    this.hostIndices.set(origin, index);
    return index;
  }

  /** Replaces a host's configured limit (protocol detected later, adaptation within the caps in M8). */
  setHostLimit(hostIndex: number, maxInFlight: number): void {
    const host = this.host(hostIndex);
    const limit = positiveInteger(maxInFlight, DEFAULT_HOST_MAX_IN_FLIGHT, 'maxInFlight');
    // A host still recovering from a 429 keeps its halved limit, within the new one.
    const throttled = host.throttledLimit < host.baseLimit;
    host.throttledLimit = throttled && host.throttledLimit < limit ? host.throttledLimit : limit;
    host.baseLimit = limit;
    this.scheduleRefill();
  }

  /** The current limit of a host: its configured limit, halved after 429 responses, 1 while probing. */
  hostLimit(hostIndex: number): number {
    const host = this.host(hostIndex);
    const limit = Math.min(host.throttledLimit, this.bandwidth.requestsPerHost());
    return host.consecutiveTransient >= PROBE_AFTER_TRANSIENT_FAILURES ? 1 : limit;
  }

  /** Requests in flight to a host. */
  inFlightOnHost(hostIndex: number): number {
    return this.host(hostIndex).inFlight;
  }

  /**
   * A rate group: requests started with its index, on any host, are held to `maxRequestsPerSecond` over any window of
   * a second (a source's declared rate limit, F222), without slowing other requests to the same hosts (KB-109).
   */
  registerRate(maxRequestsPerSecond: number): number {
    this.rates.push(rateRing(maxRequestsPerSecond));
    return this.rates.length - 1;
  }

  /** True when a new request to the host, in rate group `rateIndex` (-1 for none), would get a slot now. */
  hasFreeSlot(hostIndex: number, rateIndex = -1): boolean {
    const host = this.host(hostIndex);
    return (
      this.counters.inFlight < this.maxInFlight &&
      host.inFlight < this.hostLimit(hostIndex) &&
      this.rateAllows(host.rate) &&
      this.rateAllows(this.rates[rateIndex])
    );
  }

  /**
   * True when a request may start now under a rate limit: fewer than the limit started in the last window. Otherwise
   * a refill is scheduled for when the oldest of them leaves the window (F222).
   */
  private rateAllows(ring: RateRing | undefined): boolean {
    if (ring === undefined) return true;
    const waitMs = rateWaitMs(ring, this.options.now());
    if (waitMs <= 0) return true;
    if (!this.rateTimerArmed) {
      this.rateTimerArmed = true;
      this.options.setTimer(() => {
        this.rateTimerArmed = false;
        this.scheduleRefill();
      }, waitMs);
    }
    return false;
  }

  /** True while a request for the key is in flight and not being aborted. */
  isInFlight(key: RequestKey): boolean {
    return this.flights.has(key);
  }

  /** Adds a client that receives freed slots; returns a function that removes it. */
  addClient(client: NetworkPoolClient): () => void {
    this.clients.push(client);
    this.scheduleRefill();
    return () => {
      const at = this.clients.indexOf(client);
      if (at >= 0) this.clients.splice(at, 1);
    };
  }

  /**
   * Attaches a consumer to the request for `key`: to the one in flight if any (coalescing, no slot needed), otherwise
   * to a new transport request when the host and the pool have a free slot. Returns a consumer id for
   * {@link NetworkPool.release}, or {@link NO_SLOT} when nothing started; the caller then keeps the tile queued.
   * The consumer may be called before this returns when the transport completes synchronously. `rateIndex` names the
   * request's rate group ({@link registerRate}), -1 for none.
   */
  request(
    key: RequestKey,
    tileRequest: TileRequest,
    transport: TileTransport,
    consumer: RequestConsumer,
    timeouts: TimeoutsMs = this.defaultTimeouts,
    rateIndex = -1,
  ): number {
    if (this.disposed) return NO_SLOT;
    const existing = this.flights.get(key);
    if (existing !== undefined) {
      this.counters.coalesced++;
      return this.attach(existing, consumer);
    }
    const host = this.host(tileRequest.hostIndex);
    if (!this.hasFreeSlot(tileRequest.hostIndex, rateIndex)) return NO_SLOT;
    const flight: Flight = {
      key,
      host,
      consumerIds: [],
      consumers: [],
      abort: undefined,
      settled: false,
      aborting: false,
      unwantedSinceMs: 0,
      graceTimer: NO_TIMER,
      safetyTimer: NO_TIMER,
      startMs: this.bandwidth.started(this.options.now()),
    };
    const id = this.attach(flight, consumer);
    this.flights.set(key, flight);
    host.inFlight++;
    recordStart(host.rate, this.options.now());
    recordStart(this.rates[rateIndex], this.options.now());
    this.counters.inFlight++;
    this.counters.started++;
    flight.safetyTimer = this.options.setTimer(
      () => this.enforceTimeout(flight),
      timeouts.totalMs + this.timeoutSlackMs,
    );
    this.startTransport(flight, tileRequest, transport, timeouts);
    return id;
  }

  /**
   * Detaches a consumer: it will not be called. When the last consumer leaves, the request is aborted after the abort
   * grace period unless a consumer attaches again meanwhile. Returns false for an unknown or settled consumer.
   */
  release(consumerId: number): boolean {
    const flight = this.consumerFlights.get(consumerId);
    if (flight === undefined) return false;
    this.consumerFlights.delete(consumerId);
    const at = flight.consumerIds.indexOf(consumerId);
    flight.consumerIds.splice(at, 1);
    flight.consumers.splice(at, 1);
    if (flight.consumers.length > 0 || flight.settled) return true;
    flight.unwantedSinceMs = this.options.now();
    if (this.abortGraceMs <= 0) this.abortFlight(flight);
    else if (flight.graceTimer === NO_TIMER) this.armGrace(flight, this.abortGraceMs);
    return true;
  }

  /** Aborts every request and stops granting slots; consumers are not called. */
  dispose(): void {
    this.disposed = true;
    this.clients.length = 0;
    for (const flight of [...this.flights.values()]) {
      for (const id of flight.consumerIds) this.consumerFlights.delete(id);
      flight.consumerIds.length = 0;
      flight.consumers.length = 0;
      this.abortFlight(flight);
    }
  }

  private host(hostIndex: number): Host {
    const host = this.hosts[hostIndex];
    if (host === undefined) throw new RangeError(`Unknown host index ${String(hostIndex)}: call registerHost first.`);
    return host;
  }

  private attach(flight: Flight, consumer: RequestConsumer): number {
    const id = this.nextConsumerId++;
    flight.consumerIds.push(id);
    flight.consumers.push(consumer);
    this.consumerFlights.set(id, flight);
    return id;
  }

  private startTransport(flight: Flight, request: TileRequest, transport: TileTransport, timeouts: TimeoutsMs): void {
    let abort: AbortHandle;
    try {
      abort = transport.start(request, timeouts, (result) => this.settle(flight, result));
    } catch (error) {
      // A consumer threw inside a synchronous `done`: the request is settled, the error is theirs.
      if (flight.settled) throw error;
      // A transport that throws instead of reporting still releases its slot.
      this.settle(flight, { kind: 'network-error' });
      return;
    }
    if (flight.settled) return;
    flight.abort = abort;
    if (flight.aborting) abort();
  }

  private armGrace(flight: Flight, delayMs: number): void {
    flight.graceTimer = this.options.setTimer(() => {
      flight.graceTimer = NO_TIMER;
      if (flight.settled || flight.consumers.length > 0) return;
      const elapsedMs = this.options.now() - flight.unwantedSinceMs;
      // Re-released after a consumer came back: wait out the rest of the grace period from the last release.
      if (elapsedMs < this.abortGraceMs) this.armGrace(flight, this.abortGraceMs - elapsedMs);
      else this.abortFlight(flight);
    }, delayMs);
  }

  /** Stops attaching to the flight and asks the transport to abort; the slot is released when it reports. */
  private abortFlight(flight: Flight): void {
    if (flight.settled || flight.aborting) return;
    flight.aborting = true;
    if (this.flights.get(flight.key) === flight) this.flights.delete(flight.key);
    flight.abort?.();
  }

  /** The transport has not reported within its total timeout plus the slack: abort it and release the slot. */
  private enforceTimeout(flight: Flight): void {
    flight.safetyTimer = NO_TIMER;
    if (flight.settled) return;
    const abort = flight.abort;
    // Settle first, so the 'aborted' report the abort triggers is ignored and consumers see the timeout.
    try {
      this.settle(flight, flight.aborting ? { kind: 'aborted' } : { kind: 'timeout' });
    } finally {
      abort?.();
    }
  }

  /** The single exit path of a request: releases its slot once, updates host health, then delivers the result. */
  private settle(flight: Flight, result: TransportResult): void {
    if (flight.settled) return;
    flight.settled = true;
    if (flight.graceTimer !== NO_TIMER) this.options.clearTimer(flight.graceTimer);
    if (flight.safetyTimer !== NO_TIMER) this.options.clearTimer(flight.safetyTimer);
    flight.graceTimer = NO_TIMER;
    flight.safetyTimer = NO_TIMER;
    if (this.flights.get(flight.key) === flight) this.flights.delete(flight.key);
    flight.host.inFlight--;
    this.counters.inFlight--;
    this.bandwidth.ended(this.options.now(), flight.startMs, result);
    this.recordOutcome(flight.host, result);
    for (const id of flight.consumerIds) this.consumerFlights.delete(id);
    this.scheduleRefill();
    this.deliver(flight, result);
  }

  private recordOutcome(host: Host, result: TransportResult): void {
    const failureClass = classifyTransportResult(result);
    if (failureClass === FAILURE_ABORTED) {
      this.counters.aborted++;
      return;
    }
    this.counters.completed++;
    if (result.kind === 'timeout') this.counters.timedOut++;
    if (failureClass !== FAILURE_TRANSIENT) {
      host.consecutiveTransient = 0;
      if (host.throttledLimit < host.baseLimit && ++host.responsesSinceThrottle >= RECOVERY_RESPONSES) {
        host.throttledLimit++;
        host.responsesSinceThrottle = 0;
      }
      return;
    }
    host.consecutiveTransient++;
    if (isRateLimited(result)) {
      this.counters.rateLimited++;
      const halved = host.throttledLimit >> 1;
      host.throttledLimit = halved > 1 ? halved : 1;
      host.responsesSinceThrottle = 0;
    }
  }

  /**
   * Calls every consumer; each one after the first gets its own copy of the bytes, so each can transfer them to a
   * worker. A throwing consumer does not keep the others from their result; the first error is rethrown afterwards.
   */
  private deliver(flight: Flight, result: TransportResult): void {
    const consumers = flight.consumers.slice();
    flight.consumerIds.length = 0;
    flight.consumers.length = 0;
    if (consumers.length === 0) {
      if (result.kind === 'ok') this.options.onUnclaimedResult?.(flight.key, result);
      return;
    }
    const results = consumers.map((_, i) => (i === 0 || result.kind !== 'ok' ? result : copyBytes(result)));
    let failure: { error: unknown } | undefined;
    consumers.forEach((consumer, i) => {
      try {
        consumer(results[i] as TransportResult);
      } catch (error) {
        failure ??= { error };
      }
    });
    if (failure !== undefined) throw failure.error;
  }

  private scheduleRefill(): void {
    if (this.refillPending || this.disposed) return;
    this.refillPending = true;
    this.queueTask(() => {
      this.refillPending = false;
      this.refill();
    });
  }

  /**
   * Grants free slots, best queued request first across clients and hosts, until slots or queued requests run out.
   * A client that starts nothing when granted is skipped for the rest of the pass.
   */
  private refill(): void {
    if (this.disposed) return;
    const skipped = new Set<NetworkPoolClient>();
    for (let grants = 0; grants < 4 * this.maxInFlight + 64; grants++) {
      if (this.counters.inFlight >= this.maxInFlight) return;
      let bestClient: NetworkPoolClient | undefined;
      let bestHost = -1;
      let bestPriority = Infinity;
      for (let hostIndex = 0; hostIndex < this.hosts.length; hostIndex++) {
        if (!this.hasFreeSlot(hostIndex)) continue;
        for (const client of this.clients) {
          if (skipped.has(client)) continue;
          const priority = client.bestQueuedPriority(hostIndex);
          if (priority < bestPriority) {
            bestPriority = priority;
            bestClient = client;
            bestHost = hostIndex;
          }
        }
      }
      if (bestClient === undefined) return;
      if (!bestClient.grant(bestHost)) skipped.add(bestClient);
    }
    // Coalesced grants use no slot; a long run of them continues in the next task.
    this.scheduleRefill();
  }
}

function copyBytes(result: TransportResult & { kind: 'ok' }): TransportResult {
  return { kind: 'ok', bytes: result.bytes.slice(0), contentType: result.contentType };
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${String(value)}.`);
  }
  return value;
}
