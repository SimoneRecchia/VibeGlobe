// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
import type { CompressedTileImage, DecodedTile, Ktx2Target } from '@vibeglobe/core';
import { ToneMatcher } from './tone-matching.js';
import {
  ClampToEdgeWrapping,
  CompressedTexture,
  DataTexture,
  FloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  LinearSRGBColorSpace,
  NearestFilter,
  RedFormat,
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

/** Tile textures made again a frame after the anisotropy changed (KB-288): a few milliseconds of uploads at most. */
const REFILTER_PER_FRAME = 4;

/** A terrain height grid (`HeightGrid` of `@vibeglobe/core`): (cells + 1)² float32 heights, rows from the north. */
interface HeightImage {
  readonly cells: number;
  readonly heightsMeters: Float32Array;
}

function isHeights(image: unknown): image is HeightImage {
  return (
    typeof image === 'object' && image !== null && (image as Partial<HeightImage>).heightsMeters instanceof Float32Array
  );
}

/**
 * A height grid as an R32F texture of its vertices, read with `textureLoad` by the surface material (ADR 0006 §5):
 * no filtering, no mipmaps, no color space.
 */
function heightTexture(image: HeightImage): Texture {
  const side = image.cells + 1;
  const texture = new DataTexture(image.heightsMeters, side, side, RedFormat, FloatType);
  texture.flipY = false;
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
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
  /**
   * The textures by handle. A map, not an array: handles are a layer's index times 2^22 plus a slot, so an array would
   * be hundreds of millions of holes long, and walking it froze the view for a second (KB-298).
   */
  private readonly entries = new Map<number, Entry>();
  private count = 0;
  private bytes = 0;
  private compressed = 0;
  /** The handles {@link refilterSome} still has to check after the anisotropy changed. */
  private stale: number[] = [];

  /** The tone matching of imagery source chains (F249): tile means by handle, gains by source. */
  readonly tones = new ToneMatcher();
  /** The polar caps' fills (KB-211), made again with the base image. */
  readonly caps = new PolarCapTextures();

  constructor(private readonly anisotropy: () => number) {}

  /**
   * Takes a new world base image: the polar caps' fills are made again with its texture, and the tones of layers
   * matched to the imagery below are measured against its image (F633). Returns the texture.
   */
  setBase(texture: Texture, image: unknown, renderer: Parameters<PolarCapTextures['rebuild']>[1]): Texture {
    this.tones.measureBase(image);
    return this.caps.rebuild(texture, renderer);
  }

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

  /** The decoded image under a handle, if any (tone matching measures it on first use, F249). */
  readonly imageOf = (handle: number): unknown => this.entries.get(handle)?.tile.image;

  /** The texture under a handle, if any. */
  get(handle: number): Texture | undefined {
    return this.entries.get(handle)?.texture;
  }

  /** Creates the texture under `handle`, replacing one held there, and uploads it now. */
  upload(renderer: WebGPURenderer, handle: number, tile: DecodedTile): void {
    this.release(handle, false);
    const entry: Entry = { tile, texture: this.create(tile) };
    this.entries.set(handle, entry);
    this.count++;
    this.bytes += tile.gpuBytes;
    if (isCompressed(tile.image)) this.compressed++;
    renderer.initTexture(entry.texture);
  }

  /** Disposes the texture under `handle`; `closeImage` also frees the decoded image (an `ImageBitmap`'s memory). */
  release(handle: number, closeImage = true): void {
    const entry = this.entries.get(handle);
    if (!entry) return;
    entry.texture.dispose();
    if (closeImage) (entry.tile.image as { close?: () => void }).close?.();
    this.entries.delete(handle);
    this.tones.release(handle);
    this.count--;
    this.bytes -= entry.tile.gpuBytes;
    if (isCompressed(entry.tile.image)) this.compressed--;
  }

  /** Disposes every texture, keeping the images: the GPU copies are gone after a device loss. */
  disposeTextures(): void {
    for (const entry of this.entries.values()) entry.texture.dispose();
  }

  /** Creates and uploads every texture again on a new renderer, from the kept images. */
  restore(renderer: WebGPURenderer): void {
    for (const entry of this.entries.values()) {
      entry.texture = this.create(entry.tile);
      renderer.initTexture(entry.texture);
    }
  }

  /**
   * Gives every texture held the current anisotropy (F398: a quality preset changed it). `base` (the world image) is
   * filtered again now; the tiles are made again from their kept images a few a frame by {@link refilterSome}, since
   * creating and uploading every tile in one task froze the view for most of a second while the adaptive quality
   * stepped (KB-288). Height grids are not filtered so.
   */
  refilter(base?: Texture): void {
    const level = this.anisotropy();
    if (base && base.anisotropy !== level) {
      base.anisotropy = level;
      base.needsUpdate = true;
    }
    this.stale = [...this.entries.keys()];
  }

  /**
   * Makes again, with the current anisotropy, up to `count` tile textures that have another one; a frame calls it
   * until every texture has the level. Returns how many it made.
   */
  refilterSome(renderer: WebGPURenderer, count = REFILTER_PER_FRAME): number {
    const level = this.anisotropy();
    let made = 0;
    while (made < count && this.stale.length) {
      const entry = this.entries.get(this.stale.pop() ?? -1);
      if (!entry || isHeights(entry.tile.image) || entry.texture.anisotropy === level) continue;
      entry.texture.dispose();
      entry.texture = this.create(entry.tile);
      renderer.initTexture(entry.texture);
      made++;
    }
    return made;
  }

  /** Releases everything. */
  clear(): void {
    for (const handle of [...this.entries.keys()]) this.release(handle);
    // Also drops the caps' renderer and base image: a destroyed globe the host still references holds neither (KB-045).
    this.caps.rebuild(undefined, undefined);
  }

  private create(tile: DecodedTile): Texture {
    const image = tile.image;
    if (isHeights(image)) return heightTexture(image);
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
 * The polar caps' fills (KB-211), north then south: 1 × 1 textures of their colors, sampled like the base image (on
 * WebGPU the sampler set up with a binding stays when its texture changes), made again when the colors or the base
 * image change.
 */
class PolarCapTextures {
  private colors: readonly string[] = ['#78a9cd', '#f2f3f7'];
  /** The textures, empty until the base image is up. */
  textures: Texture[] = [];
  private base: Texture | undefined;
  private renderer: WebGPURenderer | undefined;

  /** New colors, `#rrggbb`, drawn from the next frame. */
  setColors(north: string, south: string): void {
    this.colors = [north, south];
    this.rebuild(this.base, this.renderer);
  }

  /**
   * Textures sampled like the base image `base`, or none without it, uploaded now as the base image is: a cap that
   * comes into view later uploads nothing (F052). Returns `base`.
   */
  rebuild<T extends Texture | undefined>(base: T, renderer: WebGPURenderer | undefined): T {
    this.dispose();
    this.base = base;
    this.renderer = renderer;
    this.textures = base ? this.colors.map((rgb) => createColorTexture(rgb, base)) : [];
    for (const texture of this.textures) renderer?.initTexture(texture);
    return base;
  }

  /** Frees the textures. */
  dispose(): void {
    for (const texture of this.textures) texture.dispose();
    this.textures = [];
  }
}

/** A 1 × 1 texture of one `#rrggbb` sRGB color, sampled like `like`. */
function createColorTexture(hex: string, like: Texture): DataTexture {
  const rgb = parseInt(hex.slice(1), 16);
  const texture = new DataTexture(Uint8Array.of(rgb >> 16, (rgb >> 8) & 255, rgb & 255, 255), 1, 1);
  texture.colorSpace = like.colorSpace;
  texture.wrapS = like.wrapS;
  texture.wrapT = like.wrapT;
  texture.minFilter = like.minFilter;
  texture.magFilter = like.magFilter;
  texture.anisotropy = like.anisotropy;
  texture.needsUpdate = true;
  return texture;
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
