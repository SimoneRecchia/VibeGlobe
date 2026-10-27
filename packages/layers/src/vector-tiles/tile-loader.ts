// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Loads vector tiles for the renderer (F442, F443; ADR 0131): requests through the page's request pool when the
 * engine gives one (per-host limits, coalescing, cancellation), else straight through the transport; lays tiles out
 * on the engine's worker pool (`layout-vector-tile`), else inline. Keeps each tile's bytes, so a layout or filter
 * change lays it out again without downloading it (F450). Tiles no frame wants any more are cancelled; the cache
 * keeps the most recently used ones within its size.
 */
import type { AbortHandle, NetworkPool, TileTransport, TransportResult, WorkerPool } from '@vibeglobe/core';
import { layoutDecodable, type Bucket } from './layout-tile.js';
import type { StyleLayerJson } from './style-layer.js';
import { tileKey, type TileId } from './tile-pyramid.js';

/** A tile laid out for the current style. */
export interface LoadedTile {
  readonly key: string;
  readonly tile: TileId;
  readonly buckets: readonly Bucket[];
  /** The layout version these buckets were made for. */
  readonly version: number;
}

/** A tile a frame wants, with its URL and priority (lower first). */
export interface WantedTile {
  readonly tile: TileId;
  readonly url: string;
  readonly priority: number;
}

/** Loader options. */
export interface TileLoaderOptions {
  readonly transport: TileTransport;
  readonly network?: NetworkPool | undefined;
  readonly workers?: WorkerPool | undefined;
  /** Called when a tile is ready (to ask for a frame). */
  readonly onReady: () => void;
  /** Tiles kept in memory, the visible ones and their stand-ins included (default 256). */
  readonly maxTiles?: number;
  /** Monotonic milliseconds. */
  readonly now?: () => number;
}

const TIMEOUTS_MS = { firstByteMs: 10_000, totalMs: 30_000 };
/** Without a request pool, requests in flight at once. */
const DIRECT_MAX_IN_FLIGHT = 6;
/** A tile that failed (other than not found) is requested again after this long. */
const RETRY_MS = 5_000;

interface Entry {
  readonly key: string;
  readonly tile: TileId;
  readonly url: string;
  priority: number;
  state: 'queued' | 'fetching' | 'layout' | 'ready' | 'missing' | 'failed';
  bytes?: ArrayBuffer;
  loaded?: LoadedTile;
  consumer: number | undefined;
  abort: AbortHandle | undefined;
  task: number | undefined;
  retryAtMs: number;
  usedAtFrame: number;
  /** The next request fetches past the HTTP cache: the last bytes did not lay out (TG-04). */
  reload?: boolean;
}

/** Loads and lays out the tiles of one source. */
export class VectorTileLoader {
  /** Every URL requested, in order (tests read it: F442, F450). */
  readonly requestLog: string[] = [];
  private readonly entries = new Map<string, Entry>();
  private layers: readonly StyleLayerJson[] = [];
  private version = 0;
  private frame = 0;
  private direct = 0;
  private readonly hosts = new Map<string, number>();
  private readonly removeClient: (() => void) | undefined;
  private disposed = false;
  /** Draws a frame when a failed tile may be requested again: an idle globe draws none on its own (TG-04). */
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: TileLoaderOptions) {
    this.removeClient = options.network?.addClient({
      bestQueuedPriority: (host) => this.bestQueued(host)?.priority ?? Infinity,
      grant: (host) => {
        const entry = this.bestQueued(host);
        return entry !== undefined && this.start(entry);
      },
    });
  }

  /** The style layers of this source and the layout version they belong to; a new version lays out tiles again. */
  setLayers(layers: readonly StyleLayerJson[], version: number): void {
    this.layers = layers;
    if (version === this.version) return;
    this.version = version;
    // The tiles the last frame used now; the others when a frame wants them again (`update`).
    for (const entry of this.entries.values())
      if (entry.state === 'ready' && entry.usedAtFrame >= this.frame) this.layout(entry);
  }

  /** The tile when laid out (possibly for an older version while the new layout runs). */
  get(tile: TileId): LoadedTile | undefined {
    return this.entries.get(tileKey(tile))?.loaded;
  }

  /** Whether a tile can never be drawn: the source has no such tile (404 or empty). */
  isMissing(tile: TileId): boolean {
    return this.entries.get(tileKey(tile))?.state === 'missing';
  }

  /**
   * This frame's wanted tiles, and the ones to keep (stand-ins drawn). Starts what it can; cancels what no frame
   * wants; evicts the least recently used tiles beyond the cache size.
   */
  update(wanted: readonly WantedTile[], keep: ReadonlySet<string>): void {
    this.frame++;
    const now = this.options.now?.() ?? Date.now();
    const wantedKeys = new Set<string>();
    for (const w of wanted) {
      const key = tileKey(w.tile);
      wantedKeys.add(key);
      let entry = this.entries.get(key);
      if (entry === undefined) {
        entry = {
          key,
          tile: w.tile,
          url: w.url,
          priority: w.priority,
          state: 'queued',
          retryAtMs: 0,
          usedAtFrame: 0,
          consumer: undefined,
          abort: undefined,
          task: undefined,
        };
        this.entries.set(key, entry);
      }
      entry.priority = w.priority;
      entry.usedAtFrame = this.frame;
      if (entry.state === 'failed' && now >= entry.retryAtMs) entry.state = 'queued';
    }
    for (const key of keep) {
      const entry = this.entries.get(key);
      if (entry !== undefined) entry.usedAtFrame = this.frame;
    }
    for (const entry of this.entries.values()) {
      if (entry.usedAtFrame !== this.frame && (entry.state === 'fetching' || entry.state === 'queued'))
        this.cancel(entry);
      else if (this.stale(entry)) this.layout(entry);
    }
    this.pump();
    this.evict();
  }

  /** A kept tile this frame uses, laid out for an older style version and not being laid out again. */
  private stale(entry: Entry): boolean {
    return (
      entry.usedAtFrame === this.frame &&
      entry.state === 'ready' &&
      entry.task === undefined &&
      entry.loaded !== undefined &&
      entry.loaded.version !== this.version
    );
  }

  /**
   * Tiles requested or being laid out, not ready yet, and wanted tiles waiting to be requested again after a failure
   * (TG-04; tests wait for 0).
   */
  get loading(): number {
    let n = 0;
    for (const entry of this.entries.values())
      if (
        entry.state === 'queued' ||
        entry.state === 'fetching' ||
        entry.state === 'layout' ||
        (entry.state === 'failed' && entry.usedAtFrame === this.frame)
      )
        n++;
    return n;
  }

  /** Frees everything; nothing is called back afterwards. */
  dispose(): void {
    this.disposed = true;
    clearTimeout(this.retryTimer);
    this.removeClient?.();
    for (const entry of this.entries.values()) this.cancel(entry);
    this.entries.clear();
  }

  private bestQueued(host: number): Entry | undefined {
    let best: Entry | undefined;
    for (const entry of this.entries.values()) {
      if (entry.state !== 'queued' || this.hostOf(entry.url) !== host) continue;
      if (best === undefined || entry.priority < best.priority) best = entry;
    }
    return best;
  }

  private hostOf(url: string): number {
    const network = this.options.network;
    if (network === undefined) return -1;
    let origin: string;
    try {
      origin = new URL(url, (globalThis as { location?: { href: string } }).location?.href).origin;
    } catch {
      origin = '';
    }
    let index = this.hosts.get(origin);
    if (index === undefined) {
      index = network.registerHost(origin);
      this.hosts.set(origin, index);
    }
    return index;
  }

  private pump(): void {
    const queued = [...this.entries.values()]
      .filter((e) => e.state === 'queued')
      .sort((a, b) => a.priority - b.priority);
    for (const entry of queued) {
      if (!this.start(entry) && this.options.network === undefined) break;
    }
  }

  private start(entry: Entry): boolean {
    const network = this.options.network;
    const request = {
      url: entry.url,
      hostIndex: Math.max(0, this.hostOf(entry.url)),
      ...(entry.reload === true ? { reload: true } : {}),
    };
    const done = (result: TransportResult) => this.fetched(entry, result);
    if (network !== undefined) {
      if (!network.hasFreeSlot(request.hostIndex)) return false;
      const id = network.request(`vt:${entry.url}`, request, this.options.transport, done, TIMEOUTS_MS);
      if (id < 0) return false;
      entry.consumer = id;
    } else {
      if (this.direct >= DIRECT_MAX_IN_FLIGHT) return false;
      this.direct++;
      entry.abort = this.options.transport.start(request, TIMEOUTS_MS, (result) => {
        this.direct--;
        done(result);
      });
    }
    entry.state = 'fetching';
    this.requestLog.push(entry.url);
    return true;
  }

  private cancel(entry: Entry): void {
    if (entry.state === 'fetching') {
      if (entry.consumer !== undefined) this.options.network?.release(entry.consumer);
      entry.abort?.();
    }
    if (entry.task !== undefined) this.options.workers?.cancel(entry.task);
    entry.consumer = undefined;
    entry.abort = undefined;
    entry.task = undefined;
    if (entry.state === 'fetching' || entry.state === 'queued') this.entries.delete(entry.key);
  }

  private fetched(entry: Entry, result: TransportResult): void {
    entry.consumer = undefined;
    entry.abort = undefined;
    if (this.disposed || this.entries.get(entry.key) !== entry) return;
    // An HTML page is never a tile: static hosts with a single-page fallback answer missing files with one.
    if (result.kind === 'ok' && result.bytes.byteLength > 0 && !result.contentType.startsWith('text/html')) {
      entry.bytes = result.bytes;
      this.layout(entry);
    } else if (result.kind === 'ok' || (result.kind === 'status' && (result.status === 404 || result.status === 204))) {
      entry.state = 'missing';
      this.options.onReady();
    } else if (result.kind !== 'aborted') this.failed(entry);
    this.pump();
  }

  /** Marks a tile failed: requested again after {@link RETRY_MS}, in the first frame drawn from then on. */
  private failed(entry: Entry): void {
    entry.state = 'failed';
    entry.retryAtMs = (this.options.now?.() ?? Date.now()) + RETRY_MS;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.disposed) this.options.onReady();
    }, RETRY_MS);
  }

  private layout(entry: Entry): void {
    const bytes = entry.bytes;
    if (bytes === undefined) return;
    const version = this.version;
    const input = { bytes: bytes.slice(0), layers: this.layers, zoom: entry.tile.z, tile: entry.tile };
    if (entry.state !== 'ready') entry.state = 'layout';
    const finish = (buckets: Bucket[]) => {
      entry.task = undefined;
      if (this.disposed || this.entries.get(entry.key) !== entry) return;
      if (entry.loaded !== undefined && entry.loaded.version > version) return;
      entry.loaded = { key: entry.key, tile: entry.tile, buckets, version };
      entry.state = 'ready';
      this.options.onReady();
    };
    // Bytes that do not decode or lay out (truncated or corrupted on the way) are fetched again later, like a failed
    // download.
    const retryLater = (): void => {
      entry.task = undefined;
      if (this.disposed || this.entries.get(entry.key) !== entry || entry.state === 'ready') return;
      delete entry.bytes;
      // The browser may have stored the broken body with the server's validators: revalidating returns it again.
      entry.reload = true;
      this.failed(entry);
    };
    const workers = this.options.workers;
    if (workers === undefined) {
      const buckets = layoutDecodable(input);
      if (buckets === undefined) retryLater();
      else finish(buckets);
      return;
    }
    entry.task = workers.run(
      { task: 'layout-vector-tile', input, transfer: [input.bytes], priority: entry.priority },
      (outcome) => {
        if (outcome.ok) finish(outcome.output as Bucket[]);
        // Any other failure (a worker crash, bytes that break the layout) is retried the same way (TG-04).
        else if (outcome.error.code !== 'cancelled' && outcome.error.code !== 'aborted') retryLater();
      },
    );
  }

  private evict(): void {
    const max = this.options.maxTiles ?? 256;
    if (this.entries.size <= max) return;
    const old = [...this.entries.values()]
      .filter((e) => e.usedAtFrame !== this.frame)
      .sort((a, b) => a.usedAtFrame - b.usedAtFrame);
    for (const entry of old.slice(0, this.entries.size - max)) {
      this.cancel(entry);
      this.entries.delete(entry.key);
    }
  }
}
