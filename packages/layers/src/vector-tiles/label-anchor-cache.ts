// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { CrossTileSymbolIndex } from './symbol-placement.js';

/** Anchor sets kept before those of tiles the frame did not read are dropped (the view left them). */
const MAX_ANCHOR_SETS = 256;

/**
 * The label anchors of each tile and style layer (keyed `z/x/y|layer|version`), and which ones the current frame read:
 * past {@link MAX_ANCHOR_SETS}, the sets of tiles the frame did not read go, with their labels in the cross-tile
 * index. They hold the tiles' line geometry, which would otherwise stay for the session.
 */
export class LabelAnchorCache<T> {
  private readonly sets = new Map<string, T>();
  private readonly used = new Set<string>();

  /** Anchor sets held. */
  get size(): number {
    return this.sets.size;
  }

  /** The anchors of a key, which the frame now reads. */
  get(key: string): T | undefined {
    this.used.add(key);
    return this.sets.get(key);
  }

  /** Keeps a key's anchors. */
  set(key: string, anchors: T): void {
    this.sets.set(key, anchors);
  }

  /** Starts a frame: no set read yet. */
  beginFrame(): void {
    this.used.clear();
  }

  /** Ends a frame: past the limit, forgets the sets it did not read and their tiles' labels in `index`. */
  endFrame(index: CrossTileSymbolIndex): void {
    if (this.sets.size <= MAX_ANCHOR_SETS) return;
    const tileOf = (key: string): string => key.slice(0, key.lastIndexOf('|'));
    const usedTiles = new Set([...this.used].map(tileOf));
    for (const key of [...this.sets.keys()]) {
      if (this.used.has(key)) continue;
      this.sets.delete(key);
      if (!usedTiles.has(tileOf(key))) index.removeTile(tileOf(key));
    }
  }
}
