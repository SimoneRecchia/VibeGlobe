// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { LinearFilter, SRGBColorSpace, Texture } from 'three/webgpu';

/** A drawn region of the atlas: texture coordinates and its size in CSS pixels. */
export interface AtlasEntry {
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
  readonly widthPx: number;
  readonly heightPx: number;
}

/** An image the application registers for markers (ADR 0037). */
export type AtlasImage = CanvasImageSource & { readonly width: number; readonly height: number };

const SIZE = 2048;
/** Pixels between entries, so linear filtering never reads a neighbor. */
const GAP = 2;

type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function createCanvas(): { canvas: OffscreenCanvas | HTMLCanvasElement; context: Canvas2D } {
  const canvas =
    typeof OffscreenCanvas === 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(SIZE, SIZE);
  canvas.width = SIZE;
  canvas.height = SIZE;
  const context = canvas.getContext('2d') as Canvas2D | null;
  if (!context) throw new Error('No 2D canvas for the layer atlas');
  return { canvas, context };
}

/**
 * The texture atlas of marker images (ADR 0037): the images applications register, packed in rows. (Labels are
 * distance fields in their own atlas, `LabelSdf`, F358.)
 * When full it starts over and the batches using it rebuild.
 */
export class LayerAtlas {
  /** Replaced by `renew` after a device loss. */
  texture: Texture;
  private readonly context: Canvas2D;
  private readonly entries = new Map<string, AtlasEntry>();
  private readonly images = new Map<string, AtlasImage>();
  private x = GAP;
  private y = GAP;
  private rowHeight = 0;
  /** Increased when the atlas starts over: entries handed out before are stale. */
  generation = 0;

  constructor() {
    const { canvas, context } = createCanvas();
    this.context = context;
    this.texture = new Texture(canvas as unknown as HTMLCanvasElement);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.minFilter = LinearFilter;
    this.texture.generateMipmaps = false;
    this.texture.flipY = false;
  }

  /** Registers or replaces a marker image by name. */
  addImage(name: string, image: AtlasImage): void {
    this.images.set(name, image);
    this.entries.delete(`i:${name}`);
  }

  /** Whether an image of this name is registered. */
  hasImage(name: string): boolean {
    return this.images.has(name);
  }

  /** The entry of a registered image at its natural size, or undefined when none has that name. */
  image(name: string): AtlasEntry | undefined {
    const key = `i:${name}`;
    const cached = this.entries.get(key);
    if (cached) return cached;
    const image = this.images.get(name);
    if (!image) return undefined;
    const at = this.allocate(image.width, image.height);
    this.context.drawImage(image, at.x, at.y);
    return this.remember(key, at.x, at.y, image.width, image.height);
  }

  private remember(key: string, x: number, y: number, width: number, height: number): AtlasEntry {
    const entry = {
      u0: x / SIZE,
      v0: y / SIZE,
      u1: (x + width) / SIZE,
      v1: (y + height) / SIZE,
      widthPx: width,
      heightPx: height,
    };
    this.entries.set(key, entry);
    this.texture.needsUpdate = true;
    return entry;
  }

  private allocate(width: number, height: number): { x: number; y: number } {
    if (this.x + width + GAP > SIZE) {
      this.x = GAP;
      this.y += this.rowHeight + GAP;
      this.rowHeight = 0;
    }
    if (this.y + height + GAP > SIZE) this.reset();
    const at = { x: this.x, y: this.y };
    this.x += width + GAP;
    this.rowHeight = Math.max(this.rowHeight, height);
    return at;
  }

  private reset(): void {
    this.context.clearRect(0, 0, SIZE, SIZE);
    this.entries.clear();
    this.x = GAP;
    this.y = GAP;
    this.rowHeight = 0;
    this.generation++;
    this.texture.needsUpdate = true;
  }

  /**
   * After a device loss: a new texture of the same canvas, uploaded at its next use. The lost renderer listens to the
   * old one, and a renderer already disposed no longer removes its listener, so keeping it kept that renderer (KB-222).
   */
  renew(): void {
    this.texture = renewed(this.texture);
  }

  /** Releases the atlas texture. */
  dispose(): void {
    this.texture.dispose();
  }
}

/** A copy of `texture` without its listeners, uploaded at its next use. */
export function renewed<T extends Texture>(texture: T): T {
  const copy = texture.clone();
  copy.needsUpdate = true;
  return copy;
}
