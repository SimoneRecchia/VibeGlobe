// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { IntegerKeyMap } from '../collections/integer-key-map.hot.js';
import { NO_SLOT } from '../scheduler/network-pool.js';
import { MAX_TILE_LEVEL, packTileKey, type TileCoord } from '../tiling/tile-key.js';

/** Not wanted, or wanted and not yet queued (M3 plan §3's tile states). */
export const UNLOADED = 0;
/** Waiting in the priority queue for a network slot. */
export const QUEUED = 1;
/** Its request is in flight. */
export const LOADING = 2;
/** Its bytes are being decoded in the worker pool. */
export const DECODING = 3;
/** Decoded, waiting in the upload queue. */
export const DECODED = 4;
/** On the GPU, drawable. */
export const READY = 5;
/** A transient failure: requested again once eligible and still wanted. */
export const FAILED = 6;
/** Exhausted retries or corrupt bytes: never requested again; ancestors stay drawn. */
export const DEAD = 7;
/** The source has nothing there (404, out of coverage or levels): never requested again. */
export const NO_DATA = 8;

/** One imagery tile of a source in one engine instance. */
export interface TileRecord {
  /** Index in the table; also the tile's texture handle relative to its loader's base. */
  readonly slot: number;
  readonly coord: TileCoord;
  state: number;
  /** The frame that last wanted the tile. */
  wantedFrame: number;
  retries: number;
  /** Network consumer id while loading, worker task id while decoding. */
  consumer: number;
  task: number;
  /** The tile belongs to the pinned base: loaded first, never evicted (ADR 0007, F084). */
  readonly pinned: boolean;
  /** The source last answered that it cannot tell yet whether the tile exists (F128). */
  availabilityUnknown: boolean;
  /** Rounds of attempts the tile was given again when its source answered after it failed (ADR 0046, at most 3). */
  rounds: number;
  /** Until when (the loader's clock) the tile may be reused, for sources that respect cache headers (F260). */
  freshUntilMs: number;
}

/**
 * The records of one source's tiles, by packed tile key and by slot, with their per-frame doubles in typed arrays
 * (ADR 0018): lookups allocate nothing; a record is created once per tile.
 */
export class TileTable {
  readonly bySlot: TileRecord[] = [];
  /** Priority key of each record's latest want, by slot (lower first). */
  priorities = new Float64Array(1024);
  /** Engine time from which a failed tile may be requested again, by slot. */
  eligibleAt = new Float64Array(1024);
  /** Engine time since which each record has been wanted in every frame, by slot (F287). */
  wantedSince = new Float64Array(1024);
  private readonly records = new IntegerKeyMap<TileRecord>(1024);
  private readonly coord: TileCoord = { root: 0, level: 0, x: 0, y: 0 };
  /** {@link TileTable.findInside}'s key, in an array so passing it boxes nothing (ADR 0018). */
  private readonly key = new Float64Array(1);

  /** `rootTilesX` of the source's tiling scheme; tiles at or above `pinnedLevel` are pinned. */
  constructor(
    private readonly rootTilesX: number,
    private readonly pinnedLevel: number,
  ) {}

  /** The record of a tile, if it exists. */
  find(level: number, x: number, y: number): TileRecord | undefined {
    const coord = this.coord;
    coord.level = level;
    coord.x = x;
    coord.y = y;
    return this.records.get(packTileKey(coord, this.rootTilesX, 1));
  }

  /**
   * {@link TileTable.find} for a tile known to lie in the pyramid (callers clamp its column and row): the key is
   * computed without packTileKey's checks, for per-query code (F144).
   */
  findInside(level: number, x: number, y: number): TileRecord | undefined {
    const columns = this.rootTilesX * (POWERS_OF_TWO[level] ?? 0);
    const above = (this.rootTilesX * ((POWERS_OF_FOUR[level] ?? 1) - 1)) / 3;
    this.key[0] = (above + y * columns + x) * 3;
    return this.records.getAt(this.key, 0);
  }

  /** The record of a tile, created on first use. */
  recordFor(level: number, x: number, y: number): TileRecord {
    return this.find(level, x, y) ?? this.create(level, x, y);
  }

  private create(level: number, x: number, y: number): TileRecord {
    const slot = this.bySlot.length;
    const record: TileRecord = {
      slot,
      coord: { root: 0, level, x, y },
      state: UNLOADED,
      wantedFrame: 0,
      retries: 0,
      consumer: NO_SLOT,
      task: -1,
      pinned: level <= this.pinnedLevel,
      availabilityUnknown: false,
      rounds: 0,
      freshUntilMs: Infinity,
    };
    this.bySlot.push(record);
    this.records.set(packTileKey(record.coord, this.rootTilesX, 1), record);
    if (slot >= this.priorities.length) {
      this.priorities = grown(this.priorities);
      this.eligibleAt = grown(this.eligibleAt);
      this.wantedSince = grown(this.wantedSince);
    }
    return record;
  }
}

/** 2^level and 4^level by level, for {@link TileTable.findInside}. */
const POWERS_OF_TWO = Float64Array.from({ length: MAX_TILE_LEVEL + 1 }, (_, level) => 2 ** level);
const POWERS_OF_FOUR = Float64Array.from({ length: MAX_TILE_LEVEL + 1 }, (_, level) => 4 ** level);

function grown(array: Float64Array<ArrayBuffer>): Float64Array<ArrayBuffer> {
  const next = new Float64Array(array.length * 2);
  next.set(array);
  return next;
}
