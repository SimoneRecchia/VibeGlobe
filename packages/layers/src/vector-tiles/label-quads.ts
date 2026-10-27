// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The label quads of a frame (ADR 0132): growable arrays reused from frame to frame, four vertices per glyph, in the
 * layout of the target's text material.
 */
import type { AtlasRect, LabelQuads } from './vector-target.js';

/** One glyph or icon to draw. */
export interface GlyphQuad {
  readonly rect: AtlasRect;
  /** Screen corners in CSS pixels: top-left, top-right, bottom-right, bottom-left (x, y each). */
  readonly corners: readonly number[];
  readonly box: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number };
  /** Text size / 24. */
  readonly scale: number;
  readonly fill: readonly number[];
  readonly halo: readonly number[];
  readonly haloWidthPx: number;
  /** An RGBA icon instead of an SDF glyph. */
  readonly icon?: boolean;
}

/** Writes quads into arrays that grow as needed. */
export class QuadWriter {
  private capacity = 0;
  private count = 0;
  private screen = new Float32Array(0);
  private uv = new Float32Array(0);
  private fill = new Float32Array(0);
  private halo = new Float32Array(0);
  private params = new Float32Array(0);

  /** Starts a new frame. */
  reset(): void {
    this.count = 0;
  }

  /** Adds one quad with an opacity factor. */
  add(q: GlyphQuad, opacity: number): void {
    if (this.count === this.capacity) this.grow();
    const v = this.count * 4;
    const { x, y, width, height } = q.rect;
    const uvs = [x, y, x + width, y, x + width, y + height, x, y + height];
    for (let i = 0; i < 4; i++) {
      this.screen[(v + i) * 2] = q.corners[i * 2] ?? 0;
      this.screen[(v + i) * 2 + 1] = q.corners[i * 2 + 1] ?? 0;
      this.uv[(v + i) * 2] = uvs[i * 2] ?? 0;
      this.uv[(v + i) * 2 + 1] = uvs[i * 2 + 1] ?? 0;
      this.fill.set(q.fill, (v + i) * 4);
      this.halo.set(q.halo, (v + i) * 4);
      this.params.set([q.scale, q.haloWidthPx, opacity, q.icon === true ? 1 : 0], (v + i) * 4);
    }
    this.count++;
  }

  /** The quads written since `reset`. */
  result(): LabelQuads {
    return {
      quads: this.count,
      screen: this.screen,
      uv: this.uv,
      fill: this.fill,
      halo: this.halo,
      params: this.params,
    };
  }

  private grow(): void {
    this.capacity = Math.max(256, this.capacity * 2);
    const n = this.capacity * 4;
    const grown = (old: Float32Array, size: number) => {
      const next = new Float32Array(n * size);
      next.set(old);
      return next;
    };
    this.screen = grown(this.screen, 2);
    this.uv = grown(this.uv, 2);
    this.fill = grown(this.fill, 4);
    this.halo = grown(this.halo, 4);
    this.params = grown(this.params, 4);
  }
}
