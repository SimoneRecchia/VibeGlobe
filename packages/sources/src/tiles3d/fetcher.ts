// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The 3D Tiles loader's requests (F462; ADR 0141): its own priority queue in front of the page's request pool
 * (`context.network`: per-host limits, coalescing, cancellation, the measured link). The pool grants a slot on a host
 * and the queue starts its most urgent request there; a cancelled request leaves the queue, or is released from the
 * pool, which aborts it after its grace period. Without a pool, a fixed number of requests run at once.
 */
import type { AbortHandle, NetworkPool, TileTransport, TransportResult } from '@vibeglobe/core';

type NetworkPoolClient = Parameters<NetworkPool['addClient']>[0];

/** A request event, for logs and tests. */
export interface RequestEvent {
  readonly kind: 'queued' | 'start' | 'done' | 'cancel';
  readonly url: string;
  readonly priority: number;
  /** The result kind, on `done`. */
  readonly result?: TransportResult['kind'];
}

/** A request the caller can reprioritize or cancel. */
export interface FetchHandle {
  readonly result: Promise<TransportResult>;
  setPriority(priority: number): void;
  /** Cancels the request: its result resolves `aborted`. */
  cancel(): void;
}

interface Entry {
  readonly url: string;
  readonly hostIndex: number;
  priority: number;
  consumer: number | undefined;
  abort: AbortHandle | undefined;
  settled: boolean;
  resolve(result: TransportResult): void;
}

const TIMEOUTS_MS = { firstByteMs: 10_000, totalMs: 60_000 };
/** Requests at once without a pool (the browser's per-host limit on HTTP/1.1). */
const LOCAL_LIMIT = 6;

/** The queue of the loader's requests. */
export class TileFetcher implements NetworkPoolClient {
  private readonly queued = new Set<Entry>();
  private readonly hosts = new Map<string, number>();
  private running = 0;
  private readonly unsubscribe: (() => void) | undefined;

  constructor(
    private readonly transport: TileTransport,
    private readonly pool: NetworkPool | undefined,
    private readonly log: (event: RequestEvent) => void = () => undefined,
  ) {
    this.unsubscribe = pool?.addClient(this);
  }

  /** Queues a request at a priority (lower first). */
  fetch(url: string, priority: number): FetchHandle {
    let resolve: (result: TransportResult) => void = () => undefined;
    const result = new Promise<TransportResult>((r) => (resolve = r));
    const entry: Entry = {
      url,
      hostIndex: this.hostIndex(url),
      priority,
      consumer: undefined,
      abort: undefined,
      settled: false,
      resolve,
    };
    this.queued.add(entry);
    this.log({ kind: 'queued', url, priority });
    queueMicrotask(() => this.pump());
    return {
      result,
      setPriority: (p) => (entry.priority = p),
      cancel: () => this.cancel(entry),
    };
  }

  /** Starts queued requests while their hosts have free slots. */
  pump(): void {
    const hosts = new Set<number>();
    for (const entry of this.queued) hosts.add(entry.hostIndex);
    for (const host of hosts) while (this.hasSlot(host) && this.grant(host));
  }

  /** See `NetworkPoolClient`. */
  bestQueuedPriority(hostIndex: number): number {
    let best = Infinity;
    for (const entry of this.queued) if (entry.hostIndex === hostIndex && entry.priority < best) best = entry.priority;
    return best;
  }

  /** See `NetworkPoolClient`: starts the most urgent queued request on the host. */
  grant(hostIndex: number): boolean {
    let best: Entry | undefined;
    for (const entry of this.queued)
      if (entry.hostIndex === hostIndex && (best === undefined || entry.priority < best.priority)) best = entry;
    if (best === undefined) return false;
    const entry = best;
    const done = (result: TransportResult): void => this.settle(entry, result);
    if (this.pool) {
      const id = this.pool.request(
        `tiles3d:${entry.url}`,
        { url: entry.url, hostIndex },
        this.transport,
        done,
        TIMEOUTS_MS,
      );
      if (id < 0) return false;
      if (!entry.settled) entry.consumer = id;
    } else {
      this.running++;
      entry.abort = this.transport.start({ url: entry.url, hostIndex }, TIMEOUTS_MS, done);
    }
    this.queued.delete(entry);
    this.log({ kind: 'start', url: entry.url, priority: entry.priority });
    return true;
  }

  /** Stops every request. */
  dispose(): void {
    for (const entry of [...this.queued]) this.cancel(entry);
    this.unsubscribe?.();
  }

  private hasSlot(host: number): boolean {
    return this.pool ? this.pool.hasFreeSlot(host) : this.running < LOCAL_LIMIT;
  }

  private hostIndex(url: string): number {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      origin = '';
    }
    let index = this.hosts.get(origin);
    if (index === undefined) {
      index = this.pool ? this.pool.registerHost(origin) : this.hosts.size;
      this.hosts.set(origin, index);
    }
    return index;
  }

  private cancel(entry: Entry): void {
    if (entry.settled) return;
    if (this.queued.delete(entry)) {
      this.settle(entry, { kind: 'aborted' }, 'cancel');
      return;
    }
    // Settled first, so the abort's own `aborted` result is ignored and the log says why it ended.
    this.settle(entry, { kind: 'aborted' }, 'cancel');
    if (entry.consumer !== undefined) this.pool?.release(entry.consumer);
    entry.abort?.();
  }

  private settle(entry: Entry, result: TransportResult, kind: 'done' | 'cancel' = 'done'): void {
    if (entry.settled) return;
    entry.settled = true;
    if (!this.pool && entry.abort !== undefined) this.running--;
    entry.resolve(result);
    this.log({ kind, url: entry.url, priority: entry.priority, result: result.kind });
    if (!this.pool) queueMicrotask(() => this.pump());
  }
}
