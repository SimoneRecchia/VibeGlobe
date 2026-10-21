import type { DecodedTile } from '@vibeglobe/core';
import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  type WebGPURenderer,
} from 'three/webgpu';

/** Raw RGBA8 pixels, the form a decoded tile takes where there is no `ImageBitmap` (tests, Node). */
interface RgbaImage {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

interface Entry {
  readonly tile: DecodedTile;
  texture: Texture;
}

function isRgba(image: unknown): image is RgbaImage {
  return typeof image === 'object' && image !== null && (image as Partial<RgbaImage>).data instanceof Uint8Array;
}

/**
 * The imagery tile textures by engine handle (M3 plan §2.1). Images arrive decoded with their top row first, so they
 * are uploaded without a flip and v grows southward (ADR 0010 §6). Each image is kept until its handle is released, so
 * a device loss can recreate every texture without decoding again.
 */
export class TileTextures {
  private readonly entries: (Entry | undefined)[] = [];
  private count = 0;
  private bytes = 0;

  constructor(private readonly anisotropy: () => number) {}

  /** Number of textures held. */
  get size(): number {
    return this.count;
  }

  /** GPU bytes of the textures held, mip chains included. */
  get gpuBytes(): number {
    return this.bytes;
  }

  /** The texture under a handle, if any. */
  get(handle: number): Texture | undefined {
    return this.entries[handle]?.texture;
  }

  /** Creates the texture under `handle`, replacing one held there, and uploads it now. */
  upload(renderer: WebGPURenderer, handle: number, tile: DecodedTile): void {
    this.release(handle, false);
    const entry: Entry = { tile, texture: this.create(tile) };
    this.entries[handle] = entry;
    this.count++;
    this.bytes += tile.gpuBytes;
    renderer.initTexture(entry.texture);
  }

  /** Disposes the texture under `handle`; `closeImage` also frees the decoded image (an `ImageBitmap`'s memory). */
  release(handle: number, closeImage = true): void {
    const entry = this.entries[handle];
    if (!entry) return;
    entry.texture.dispose();
    if (closeImage) (entry.tile.image as { close?: () => void }).close?.();
    this.entries[handle] = undefined;
    this.count--;
    this.bytes -= entry.tile.gpuBytes;
  }

  /** Disposes every texture, keeping the images: the GPU copies are gone after a device loss. */
  disposeTextures(): void {
    for (const entry of this.entries) entry?.texture.dispose();
  }

  /** Creates and uploads every texture again on a new renderer, from the kept images. */
  restore(renderer: WebGPURenderer): void {
    for (const entry of this.entries) {
      if (!entry) continue;
      entry.texture = this.create(entry.tile);
      renderer.initTexture(entry.texture);
    }
  }

  /** Releases everything. */
  clear(): void {
    for (let handle = 0; handle < this.entries.length; handle++) this.release(handle);
    this.entries.length = 0;
  }

  private create(tile: DecodedTile): Texture {
    const image = tile.image;
    const texture = isRgba(image)
      ? new DataTexture(image.data, image.width, image.height)
      : new Texture(image as ImageBitmap);
    texture.flipY = false;
    texture.colorSpace = SRGBColorSpace;
    texture.wrapS = ClampToEdgeWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    texture.magFilter = LinearFilter;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = this.anisotropy();
    texture.needsUpdate = true;
    return texture;
  }
}

/**
 * The texture of the equirectangular world base image: top row first like every imagery tile (v grows southward,
 * ADR 0010 §6), repeating across the antimeridian.
 */
export function createBaseTexture(image: HTMLImageElement | ImageBitmap, anisotropy: number): Texture {
  const texture = new Texture(image);
  texture.flipY = false;
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}
