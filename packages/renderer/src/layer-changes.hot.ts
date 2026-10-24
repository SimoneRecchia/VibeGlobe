// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * @hotpath The features a layer changed since the last frame, marked as the layers write them and drained into upload
 * runs once per frame by `LayerBatches` (F376–F378): flags in a typed array, so a live feed's changes allocate nothing.
 * @benchmark e2e/globe-allocation.spec.ts
 */

/** Changed features of one batch: each marked once, drained in feature order as runs of consecutive features. */
export class FeatureChanges {
  private flags = new Uint8Array(0);
  /** The span holding every marked feature, [low, high); empty when low >= high. */
  private low = 0;
  private high = 0;

  /** True when no feature is marked. */
  get empty(): boolean {
    return this.low >= this.high;
  }

  /** Marks features [first, end). */
  mark(first: number, end: number): void {
    if (end > this.flags.length) this.grow(end);
    for (let f = first; f < end; f++) this.flags[f] = 1;
    if (this.empty) {
      this.low = first;
      this.high = end;
      return;
    }
    if (first < this.low) this.low = first;
    if (end > this.high) this.high = end;
  }

  /**
   * Calls `visit` with each run [first, end) of consecutive marked features, in order, and clears them; stops at the first
   * run `visit` refuses (returns false) and returns false then, the marks cleared all the same.
   */
  drain(visit: (first: number, end: number) => boolean): boolean {
    const flags = this.flags;
    const high = this.high;
    let ok = true;
    let f = this.low;
    while (f < high) {
      if (flags[f] === 0) {
        f++;
        continue;
      }
      const first = f;
      while (f < high && flags[f] === 1) flags[f++] = 0;
      if (ok && !visit(first, f)) ok = false;
    }
    this.low = 0;
    this.high = 0;
    return ok;
  }

  /** Forgets every mark (the batch is rebuilt whole). */
  clear(): void {
    this.flags.fill(0, this.low, this.high);
    this.low = 0;
    this.high = 0;
  }

  private grow(end: number): void {
    const grown = new Uint8Array(Math.max(end, this.flags.length * 2, 1024));
    grown.set(this.flags);
    this.flags = grown;
  }
}
