import type { CompressedTileImage, DecodedTile, Ktx2Target } from '@vibeglobe/core';
import {
  ClampToEdgeWrapping,
  CompressedTexture,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  LinearSRGBColorSpace,
  RepeatWrapping,
  RGB_ETC2_Format,
  RGB_S3TC_DXT1_Format,
  RGBA_ASTC_4x4_Format,
  RGBA_BPTC_Format,
  RGBA_ETC2_EAC_Format,
  SRGBColorSpace,
  Texture,
  type CompressedPixelFormat,
  type WebGPURenderer,
} from 'three/webgpu';

/** The three.js format of each compressed KTX2 target (ADR 0020 rule 5); sRGB comes from the color space. */
const COMPRESSED_FORMATS: Readonly<Record<Exclude<Ktx2Target, 'rgba8'>, CompressedPixelFormat>> = {
  bc1: RGB_S3TC_DXT1_Format,
  bc7: RGBA_BPTC_Format,
  'etc2-rgb': RGB_ETC2_Format,
  'etc2-rgba': RGBA_ETC2_EAC_Format,
  'astc-4x4': RGBA_ASTC_4x4_Format,
};

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

function isCompressed(image: unknown): image is CompressedTileImage {
  return typeof image === 'object' && image !== null && (image as Partial<CompressedTileImage>).kind === 'compressed';
}

/** A KTX2 tile's own mip chain, uploaded as it is: no flip, no generated mipmaps (ADR 0020 rule 5). */
function compressedTexture(image: CompressedTileImage): Texture {
  const mipmaps = image.levels.map((level) => ({ data: level.data, width: level.widthPx, height: level.heightPx }));
  const base = mipmaps[0] ?? { width: 1, height: 1 };
  const texture = new CompressedTexture(mipmaps, base.width, base.height, COMPRESSED_FORMATS[image.target]);
  texture.colorSpace = image.srgb ? SRGBColorSpace : LinearSRGBColorSpace;
  texture.generateMipmaps = false;
  return texture;
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
  private compressed = 0;

  constructor(private readonly anisotropy: () => number) {}

  /** Number of textures held. */
  get size(): number {
    return this.count;
  }

  /** Textures held in a block-compressed format. */
  get compressedCount(): number {
    return this.compressed;
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
    if (isCompressed(tile.image)) this.compressed++;
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
    if (isCompressed(entry.tile.image)) this.compressed--;
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
    const compressed = isCompressed(image);
    let texture: Texture;
    if (compressed) texture = compressedTexture(image);
    else if (isRgba(image)) texture = new DataTexture(image.data, image.width, image.height);
    else texture = new Texture(image as ImageBitmap);
    texture.flipY = false;
    if (!compressed) {
      texture.colorSpace = SRGBColorSpace;
      texture.generateMipmaps = true;
    }
    texture.wrapS = ClampToEdgeWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    texture.magFilter = LinearFilter;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.anisotropy = this.anisotropy();
    texture.needsUpdate = true;
    return texture;
  }
}

/**
 * The texture of the equirectangular world base image: top row first like every imagery tile (v grows southward,
 * ADR 0010 §6), repeating across the antimeridian.
 */
export function createBaseTexture(image: ImageBitmap, anisotropy: number): Texture {
  const texture = new Texture(image);
  texture.flipY = false;
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.anisotropy = anisotropy;
  texture.needsUpdate = true;
  return texture;
}
