// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Exact GPU byte sizes of tile textures (ADR 0007 §Memory, ADR 0020 §6). The budgets are hard caps, so sizes are summed
 * level by level rather than estimated with the ×4/3 rule: the rule undercounts the smallest levels of RGBA8 chains
 * and every level of a block-compressed chain, whose sizes round up to whole blocks.
 *
 * Each mip level halves the previous one, rounding down, with a floor of 1 texel (WebGPU and WebGL2 agree on this),
 * and a full chain ends at 1 × 1.
 */

/** A block-compressed texture format: the texel footprint of one block and its size in bytes. */
export interface BlockFormat {
  readonly blockWidthPx: number;
  readonly blockHeightPx: number;
  readonly bytesPerBlock: number;
}

/** Bytes per texel of an uncompressed RGBA8 texture. */
export const RGBA8_BYTES_PER_TEXEL = 4;

/** BC1 (S3TC DXT1): 4 × 4 texels in 8 bytes; the target for opaque ETC1S on devices with BC (ADR 0020 §3). */
export const BC1_FORMAT: BlockFormat = Object.freeze({ blockWidthPx: 4, blockHeightPx: 4, bytesPerBlock: 8 });
/** BC7: 4 × 4 texels in 16 bytes. */
export const BC7_FORMAT: BlockFormat = Object.freeze({ blockWidthPx: 4, blockHeightPx: 4, bytesPerBlock: 16 });
/** ETC2 RGB8: 4 × 4 texels in 8 bytes. */
export const ETC2_RGB8_FORMAT: BlockFormat = Object.freeze({ blockWidthPx: 4, blockHeightPx: 4, bytesPerBlock: 8 });
/** ETC2 RGBA8 (with EAC alpha): 4 × 4 texels in 16 bytes. */
export const ETC2_RGBA8_FORMAT: BlockFormat = Object.freeze({ blockWidthPx: 4, blockHeightPx: 4, bytesPerBlock: 16 });
/** ASTC 4x4: 4 × 4 texels in 16 bytes. */
export const ASTC_4X4_FORMAT: BlockFormat = Object.freeze({ blockWidthPx: 4, blockHeightPx: 4, bytesPerBlock: 16 });

/** An uncompressed RGBA8 texel seen as a 1 × 1 block. */
const RGBA8_TEXEL_BLOCK: BlockFormat = Object.freeze({
  blockWidthPx: 1,
  blockHeightPx: 1,
  bytesPerBlock: RGBA8_BYTES_PER_TEXEL,
});

function checkPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer, got ${value}`);
}

/** Number of levels in a full mip chain of a `widthPx` × `heightPx` texture: ⌊log2(max(width, height))⌋ + 1. */
export function fullMipLevelCount(widthPx: number, heightPx: number): number {
  checkPositiveInteger(widthPx, 'widthPx');
  checkPositiveInteger(heightPx, 'heightPx');
  let levels = 1;
  let size = widthPx > heightPx ? widthPx : heightPx;
  while (size > 1) {
    size = Math.floor(size / 2);
    levels++;
  }
  return levels;
}

/**
 * Bytes of a block-compressed texture: for each level, whole blocks across times whole blocks down times the block
 * size. `levelCount` defaults to the full chain; 1 gives the base level alone.
 */
export function blockCompressedBytes(
  widthPx: number,
  heightPx: number,
  format: BlockFormat,
  levelCount = fullMipLevelCount(widthPx, heightPx),
): number {
  checkPositiveInteger(format.blockWidthPx, 'blockWidthPx');
  checkPositiveInteger(format.blockHeightPx, 'blockHeightPx');
  checkPositiveInteger(format.bytesPerBlock, 'bytesPerBlock');
  checkPositiveInteger(levelCount, 'levelCount');
  const maxLevels = fullMipLevelCount(widthPx, heightPx);
  if (levelCount > maxLevels) {
    throw new RangeError(`levelCount ${levelCount} exceeds the ${maxLevels} levels of a ${widthPx}×${heightPx} chain`);
  }
  let bytes = 0;
  let width = widthPx;
  let height = heightPx;
  for (let level = 0; level < levelCount; level++) {
    const blocksAcross = Math.ceil(width / format.blockWidthPx);
    const blocksDown = Math.ceil(height / format.blockHeightPx);
    bytes += blocksAcross * blocksDown * format.bytesPerBlock;
    width = width > 1 ? Math.floor(width / 2) : 1;
    height = height > 1 ? Math.floor(height / 2) : 1;
  }
  return bytes;
}

/**
 * Bytes of an RGBA8 texture: the exact sum of `width × height × 4` over its levels. `levelCount` defaults to the full
 * chain, which image tiles always have (GPU-generated mipmaps, ADR 0020 §1); 1 gives the base level alone.
 */
export function rgba8Bytes(
  widthPx: number,
  heightPx: number,
  levelCount = fullMipLevelCount(widthPx, heightPx),
): number {
  return blockCompressedBytes(widthPx, heightPx, RGBA8_TEXEL_BLOCK, levelCount);
}
