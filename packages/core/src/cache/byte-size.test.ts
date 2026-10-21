import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import {
  ASTC_4X4_FORMAT,
  BC1_FORMAT,
  BC7_FORMAT,
  type BlockFormat,
  blockCompressedBytes,
  ETC2_RGB8_FORMAT,
  ETC2_RGBA8_FORMAT,
  fullMipLevelCount,
  RGBA8_BYTES_PER_TEXEL,
  rgba8Bytes,
} from './byte-size.js';

describe('fullMipLevelCount', () => {
  it('counts levels down to 1 × 1', () => {
    expect(fullMipLevelCount(1, 1)).toBe(1);
    expect(fullMipLevelCount(2, 1)).toBe(2);
    expect(fullMipLevelCount(256, 256)).toBe(9);
    expect(fullMipLevelCount(512, 256)).toBe(10);
    // ⌊log2(10)⌋ + 1: 10, 5, 2, 1.
    expect(fullMipLevelCount(10, 3)).toBe(4);
  });

  it('rejects sizes that are not positive integers', () => {
    expect(() => fullMipLevelCount(0, 4)).toThrow(RangeError);
    expect(() => fullMipLevelCount(4, 2.5)).toThrow(RangeError);
    expect(() => fullMipLevelCount(Number.NaN, 4)).toThrow(RangeError);
  });
});

describe('rgba8Bytes', () => {
  it('sums the levels of a 256 px tile exactly', () => {
    // 4 × (65,536 + 16,384 + 4,096 + 1,024 + 256 + 64 + 16 + 4 + 1) = 4 × 87,381.
    expect(rgba8Bytes(256, 256)).toBe(349_524);
    // The ×4/3 rule would give 349,525.33: close, but not the exact byte count the budgets need.
    expect(rgba8Bytes(256, 256)).not.toBe((256 * 256 * 4 * 4) / 3);
  });

  it('sums the levels of a 512 px tile exactly', () => {
    // 4 × (4^10 − 1) / 3 = 4 × 349,525.
    expect(rgba8Bytes(512, 512)).toBe(1_398_100);
  });

  it('handles rectangular and non-power-of-two sizes level by level', () => {
    // 4×2 (32) + 2×1 (8) + 1×1 (4).
    expect(rgba8Bytes(4, 2)).toBe(44);
    // 5×3 (60) + 2×1 (8) + 1×1 (4).
    expect(rgba8Bytes(5, 3)).toBe(72);
    // 1×8 (32) + 1×4 (16) + 1×2 (8) + 1×1 (4).
    expect(rgba8Bytes(1, 8)).toBe(60);
  });

  it('counts only the requested levels', () => {
    expect(rgba8Bytes(256, 256, 1)).toBe(256 * 256 * RGBA8_BYTES_PER_TEXEL);
    expect(rgba8Bytes(256, 256, 1)).toBe(262_144);
    expect(rgba8Bytes(256, 256, 2)).toBe(262_144 + 65_536);
    expect(rgba8Bytes(1, 1)).toBe(4);
  });

  it('rejects level counts beyond the full chain', () => {
    expect(() => rgba8Bytes(4, 4, 4)).toThrow(RangeError);
    expect(() => rgba8Bytes(4, 4, 0)).toThrow(RangeError);
  });

  test.prop([fc.integer({ min: 1, max: 4096 }), fc.integer({ min: 1, max: 4096 })])(
    'equals the sum of width × height × 4 over the halving levels',
    (widthPx, heightPx) => {
      let expected = 0;
      let width = widthPx;
      let height = heightPx;
      for (;;) {
        expected += width * height * 4;
        if (width === 1 && height === 1) break;
        width = Math.max(1, width >> 1);
        height = Math.max(1, height >> 1);
      }
      expect(rgba8Bytes(widthPx, heightPx)).toBe(expected);
    },
  );
});

describe('blockCompressedBytes', () => {
  it('matches the 350 KB of a 512 px BC7 tile quoted in ADR 0020', () => {
    // Blocks per level 128², 64², 32², 16², 8², 4², 2², then three 1-block levels (4×4, 2×2, 1×1 texels).
    const blocks = 16_384 + 4_096 + 1_024 + 256 + 64 + 16 + 4 + 1 + 1 + 1;
    expect(blocks).toBe(21_847);
    expect(blockCompressedBytes(512, 512, BC7_FORMAT)).toBe(blocks * 16);
    expect(blockCompressedBytes(512, 512, BC7_FORMAT)).toBe(349_552);
  });

  it('counts a 256 px BC1 chain with its block-rounded small levels', () => {
    // 64², 32², 16², 8², 4², 2², 1, 1, 1 blocks × 8 bytes.
    expect(blockCompressedBytes(256, 256, BC1_FORMAT)).toBe(5_463 * 8);
    expect(blockCompressedBytes(256, 256, ETC2_RGB8_FORMAT)).toBe(43_704);
    expect(blockCompressedBytes(256, 256, ETC2_RGBA8_FORMAT)).toBe(87_408);
    expect(blockCompressedBytes(256, 256, ASTC_4X4_FORMAT)).toBe(87_408);
  });

  it('is 8 times smaller than RGBA8 for BC1 and 4 times for BC7 at the base level', () => {
    expect(rgba8Bytes(512, 512, 1) / blockCompressedBytes(512, 512, BC1_FORMAT, 1)).toBe(8);
    expect(rgba8Bytes(512, 512, 1) / blockCompressedBytes(512, 512, BC7_FORMAT, 1)).toBe(4);
  });

  it('rounds partial blocks up for other block sizes', () => {
    const astc6x6: BlockFormat = { blockWidthPx: 6, blockHeightPx: 6, bytesPerBlock: 16 };
    // 10×10: 2×2 blocks; 5×5, 2×2 and 1×1: one block each.
    expect(blockCompressedBytes(10, 10, astc6x6)).toBe((4 + 1 + 1 + 1) * 16);
    expect(blockCompressedBytes(10, 10, astc6x6, 1)).toBe(64);
  });

  it('rejects invalid formats', () => {
    expect(() => blockCompressedBytes(4, 4, { blockWidthPx: 0, blockHeightPx: 4, bytesPerBlock: 8 })).toThrow(
      RangeError,
    );
    expect(() => blockCompressedBytes(4, 4, { blockWidthPx: 4, blockHeightPx: 4, bytesPerBlock: 0.5 })).toThrow(
      RangeError,
    );
  });
});
