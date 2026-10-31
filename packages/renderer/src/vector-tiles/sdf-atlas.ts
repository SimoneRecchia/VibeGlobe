// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * The glyph and icon atlas of vector tile labels (F448, ADR 0132), exported for data-layer labels too (F358): signed
 * distance field glyphs (the glyph PBF format: one byte per texel, 0.75 at the outline, 1/8 per texel at 24 px) and
 * RGBA sprite icons packed on shelves in one RGBA texture. Glyph texels go to every channel, so one sampler serves both
 * kinds. When the atlas is full it starts over with a new `generation`: callers add their entries again.
 */
import { DataTexture, LinearFilter, RedFormat, RGBAFormat, UnsignedByteType } from 'three/webgpu';
import { renewed } from '../layer-atlas.js';
import type { AtlasRect } from '@vibeglobe/core';

export type { AtlasRect };

/** Space left around each entry, so linear filtering never reads a neighbor. */
const PADDING = 1;

/** A shelf-packed RGBA atlas texture of SDF glyphs and icons. */
export class SdfAtlas {
  /** Replaced by `renew` after a device loss. */
  texture: DataTexture;
  /** Increases each time the atlas starts over (it was full). */
  generation = 0;
  private readonly data: Uint8Array;
  private readonly rects = new Map<string, AtlasRect>();
  private shelfY = 0;
  private shelfHeight = 0;
  private cursorX = 0;

  /**
   * `channels` 1 makes a one-channel atlas of glyphs only (data-layer labels, F358): a quarter of the memory, no
   * icons.
   */
  constructor(
    readonly size = 1024,
    private readonly channels: 1 | 4 = 4,
  ) {
    this.data = new Uint8Array(size * size * channels);
    this.texture = new DataTexture(this.data, size, size, channels === 1 ? RedFormat : RGBAFormat, UnsignedByteType);
    this.texture.magFilter = LinearFilter;
    this.texture.minFilter = LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.flipY = false;
    this.texture.needsUpdate = true;
  }

  /** The rect of an entry already added. */
  get(key: string): AtlasRect | undefined {
    return this.rects.get(key);
  }

  /** Adds a one-channel SDF glyph bitmap (`width` × `height` bytes); returns its rect, or the existing one. */
  addSdf(key: string, bitmap: ArrayLike<number>, width: number, height: number): AtlasRect | undefined {
    return this.add(key, width, height, (i) => {
      const v = bitmap[i] ?? 0;
      return [v, v, v, v];
    });
  }

  /** Adds an RGBA image (`width` × `height` × 4 bytes, straight alpha); returns its rect, or the existing one. */
  addRgba(key: string, pixels: ArrayLike<number>, width: number, height: number): AtlasRect | undefined {
    // Premultiplied, so filtering at an icon's edge does not mix in the black of its transparent texels.
    return this.add(key, width, height, (i) => {
      const a = (pixels[i * 4 + 3] ?? 0) / 255;
      return [
        Math.round((pixels[i * 4] ?? 0) * a),
        Math.round((pixels[i * 4 + 1] ?? 0) * a),
        Math.round((pixels[i * 4 + 2] ?? 0) * a),
        pixels[i * 4 + 3] ?? 0,
      ];
    });
  }

  /** After a device loss: a new texture of the same texels, without the lost renderer's listener (KB-222). */
  renew(): void {
    this.texture = renewed(this.texture);
  }

  /** Frees the texture. */
  dispose(): void {
    this.texture.dispose();
  }

  private add(
    key: string,
    width: number,
    height: number,
    texel: (index: number) => readonly [number, number, number, number],
  ): AtlasRect | undefined {
    const existing = this.rects.get(key);
    if (existing !== undefined) return existing;
    if (width <= 0 || height <= 0 || width + 2 * PADDING > this.size || height + 2 * PADDING > this.size)
      return undefined;
    let place = this.place(width + 2 * PADDING, height + 2 * PADDING);
    if (place === undefined) {
      this.reset();
      place = this.place(width + 2 * PADDING, height + 2 * PADDING);
      if (place === undefined) return undefined;
    }
    const rect = { x: place.x + PADDING, y: place.y + PADDING, width, height };
    const channels = this.channels;
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        const [r, g, b, a] = texel(row * width + col);
        const at = ((rect.y + row) * this.size + rect.x + col) * channels;
        this.data[at] = r;
        if (channels === 1) continue;
        this.data[at + 1] = g;
        this.data[at + 2] = b;
        this.data[at + 3] = a;
      }
    }
    this.rects.set(key, rect);
    this.texture.needsUpdate = true;
    return rect;
  }

  private place(width: number, height: number): { x: number; y: number } | undefined {
    if (this.cursorX + width > this.size || height > this.shelfHeight) {
      // A new shelf when the entry does not fit the current one's width or height.
      if (this.cursorX + width <= this.size && this.shelfHeight === 0) {
        this.shelfHeight = height;
      } else {
        const y = this.shelfY + this.shelfHeight;
        if (y + height > this.size) return undefined;
        this.shelfY = y;
        this.shelfHeight = height;
        this.cursorX = 0;
      }
    }
    const at = { x: this.cursorX, y: this.shelfY };
    this.cursorX += width;
    return at;
  }

  private reset(): void {
    this.data.fill(0);
    this.rects.clear();
    this.shelfY = 0;
    this.shelfHeight = 0;
    this.cursorX = 0;
    this.generation++;
  }
}
