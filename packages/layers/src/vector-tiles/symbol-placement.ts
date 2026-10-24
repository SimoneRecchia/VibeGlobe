/**
 * Symbol placement for vector-tile labels (F449, F454), original code (ADR 0041): collision of screen-space boxes in
 * an rbush index with priorities (the topmost style layer first, then `symbol-sort-key`, then importance), a
 * cross-tile index that gives the same label the same id in a parent and a child tile, so swapping tiles neither
 * duplicates nor restarts a label, and fades on the engine clock so labels never flicker.
 */
import RBush from 'rbush';

/** A screen-space box in pixels. */
export interface ScreenBox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** A label to place this pass, already projected to the screen. */
export interface SymbolCandidate {
  /** Stable id from {@link CrossTileSymbolIndex}. */
  readonly id: number;
  /** One box for a point label; one per glyph group for a line label. */
  readonly boxes: readonly ScreenBox[];
  /** Index of the style layer; higher layers are placed first. */
  readonly layerIndex: number;
  /** `symbol-sort-key` (lower first within a layer). */
  readonly sortKey: number;
  /** `text-allow-overlap`: placed even when it collides. */
  readonly allowOverlap?: boolean;
  /** `text-ignore-placement`: others may overlap it. */
  readonly ignorePlacement?: boolean;
}

interface IndexedBox extends ScreenBox {
  readonly id: number;
}

/** Sorts candidates by priority: higher style layers first, then ascending sort key, then id for determinism. */
export function byPriority(a: SymbolCandidate, b: SymbolCandidate): number {
  return b.layerIndex - a.layerIndex || a.sortKey - b.sortKey || a.id - b.id;
}

/**
 * One placement pass: candidates in priority order, each placed when none of its boxes overlaps a placed box and all
 * its boxes lie in the viewport (with `paddingPx`).
 * @returns the placed ids and their boxes (the debug API reads these).
 */
export function placeSymbols(
  candidates: readonly SymbolCandidate[],
  viewport: ScreenBox,
  paddingPx = 2,
): { placed: Set<number>; boxes: Map<number, readonly ScreenBox[]> } {
  const tree = new RBush<IndexedBox>();
  const placed = new Set<number>();
  const boxes = new Map<number, readonly ScreenBox[]>();
  for (const candidate of [...candidates].sort(byPriority)) {
    if (placed.has(candidate.id) || candidate.boxes.length === 0) continue;
    const padded = candidate.boxes.map((b) => ({
      minX: b.minX - paddingPx,
      minY: b.minY - paddingPx,
      maxX: b.maxX + paddingPx,
      maxY: b.maxY + paddingPx,
      id: candidate.id,
    }));
    const visible = candidate.boxes.every(
      (b) => b.minX >= viewport.minX && b.maxX <= viewport.maxX && b.minY >= viewport.minY && b.maxY <= viewport.maxY,
    );
    if (!visible) continue;
    if (candidate.allowOverlap !== true && padded.some((b) => tree.collides(b))) continue;
    placed.add(candidate.id);
    boxes.set(candidate.id, candidate.boxes);
    if (candidate.ignorePlacement !== true) tree.load(padded);
  }
  return { placed, boxes };
}

/** A label of one tile for the cross-tile index: its key and world position. */
export interface TileSymbol {
  /** Same text and layer give the same key (for example `${layerId}|${text}`). */
  readonly key: string;
  /** World position, Web Mercator in [0, 1] on both axes. */
  readonly worldX: number;
  readonly worldY: number;
}

interface Entry {
  readonly id: number;
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly tiles: Set<string>;
}

/**
 * Stable label ids across tiles: a label within `tolerancePx` (at the tile's zoom, 512-px tiles) of a label with the
 * same key already known gets that label's id, so a parent tile replaced by its children keeps its labels and their
 * opacity. Each id is reported once per pass, however many loaded tiles hold it.
 */
export class CrossTileSymbolIndex {
  private readonly entries = new Map<string, Entry[]>();
  private readonly byTile = new Map<string, number[]>();
  private nextId = 1;

  constructor(private readonly tolerancePx = 24) {}

  /** Indexes one tile's symbols; returns their ids in input order. */
  addTile(tileKey: string, zoom: number, symbols: readonly TileSymbol[]): number[] {
    this.removeTile(tileKey);
    const tolerance = this.tolerancePx / (512 * 2 ** zoom);
    const ids = symbols.map((symbol) => {
      const list = this.entries.get(symbol.key) ?? [];
      let entry = list.find(
        (e) => Math.abs(e.x - symbol.worldX) <= tolerance && Math.abs(e.y - symbol.worldY) <= tolerance,
      );
      if (entry === undefined) {
        entry = { id: this.nextId++, key: symbol.key, x: symbol.worldX, y: symbol.worldY, tiles: new Set() };
        list.push(entry);
        this.entries.set(symbol.key, list);
      }
      entry.tiles.add(tileKey);
      return entry.id;
    });
    this.byTile.set(tileKey, ids);
    return ids;
  }

  /** Forgets a tile; labels no other tile holds are dropped. */
  removeTile(tileKey: string): void {
    if (!this.byTile.delete(tileKey)) return;
    for (const [key, list] of this.entries) {
      const kept = list.filter((entry) => {
        entry.tiles.delete(tileKey);
        return entry.tiles.size > 0;
      });
      if (kept.length > 0) this.entries.set(key, kept);
      else this.entries.delete(key);
    }
  }

  /** The number of distinct labels known. */
  get size(): number {
    let n = 0;
    for (const list of this.entries.values()) n += list.length;
    return n;
  }
}

/** Per-label opacity that eases toward placed (1) or not placed (0) over `durationMs`; new labels fade in from 0. */
export class SymbolFader {
  private readonly opacity = new Map<number, number>();
  private lastMs: number | undefined;

  constructor(private readonly durationMs = 300) {}

  /** Advances to `nowMs` with the latest placement; labels gone and fully faded out are forgotten. */
  update(nowMs: number, placed: ReadonlySet<number>): ReadonlyMap<number, number> {
    const step = this.lastMs === undefined ? 0 : (nowMs - this.lastMs) / this.durationMs;
    this.lastMs = nowMs;
    for (const id of placed) if (!this.opacity.has(id)) this.opacity.set(id, 0);
    for (const [id, value] of this.opacity) {
      const target = placed.has(id) ? 1 : 0;
      // A label at its target stays there (TD-01: a shown label was faded down every other frame).
      const next = value < target ? Math.min(target, value + step) : Math.max(target, value - step);
      if (next === 0 && target === 0) this.opacity.delete(id);
      else this.opacity.set(id, next);
    }
    return this.opacity;
  }
}
