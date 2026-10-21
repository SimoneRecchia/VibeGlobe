import { describe, expect, it } from 'vitest';
import { chooseKtx2Target, isKtx2, Ktx2Error, ktx2GpuBytes, ktx2LevelRange, readKtx2 } from './ktx2.js';

const IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

interface FileSpec {
  vkFormat?: number;
  widthPx?: number;
  heightPx?: number;
  faces?: number;
  levels?: number;
  scheme?: number;
  model?: number;
  transfer?: number;
  /** Channel ids of the descriptor's samples. */
  channels?: number[];
  /** Bytes of each level's data. */
  levelBytes?: (level: number) => number;
}

/** A KTX2 file built field by field: header, level index, data format descriptor, then the levels' data. */
function ktx2File(spec: FileSpec = {}): Uint8Array {
  const { vkFormat = 0, widthPx = 256, heightPx = 256, faces = 1, levels = 9, scheme = 1, model = 163 } = spec;
  const channels = spec.channels ?? [0];
  const dfdBytes = 4 + 24 + 16 * channels.length;
  const dfdOffset = 80 + 24 * levels;
  const levelBytes = Array.from({ length: levels }, (_, level) => spec.levelBytes?.(level) ?? 16);
  const dataOffset = dfdOffset + dfdBytes;
  const bytes = new Uint8Array(dataOffset + levelBytes.reduce((a, b) => a + b, 0));
  const view = new DataView(bytes.buffer);
  bytes.set(IDENTIFIER);
  view.setUint32(12, vkFormat, true);
  view.setUint32(20, widthPx, true);
  view.setUint32(24, heightPx, true);
  view.setUint32(36, faces, true);
  view.setUint32(40, levels, true);
  view.setUint32(44, scheme, true);
  view.setUint32(48, dfdOffset, true);
  view.setUint32(52, dfdBytes, true);
  let offset = dataOffset;
  for (let level = 0; level < levels; level++) {
    view.setUint32(80 + level * 24, offset, true);
    view.setUint32(80 + level * 24 + 8, levelBytes[level] ?? 0, true);
    // Uncompressed sizes: 0 for BasisLZ, 16 bytes per 4 × 4 block for UASTC, the stored length for raw levels.
    const blocks = Math.ceil(Math.max(1, widthPx >> level) / 4) * Math.ceil(Math.max(1, heightPx >> level) / 4);
    const uncompressed = vkFormat !== 0 ? (levelBytes[level] ?? 0) : model === 166 ? blocks * 16 : 0;
    view.setUint32(80 + level * 24 + 16, uncompressed, true);
    offset += levelBytes[level] ?? 0;
  }
  view.setUint32(dfdOffset, dfdBytes, true);
  view.setUint16(dfdOffset + 10, dfdBytes - 4, true);
  view.setUint8(dfdOffset + 12, model);
  view.setUint8(dfdOffset + 14, spec.transfer ?? 2);
  channels.forEach((channel, i) => view.setUint8(dfdOffset + 28 + i * 16 + 3, channel));
  return bytes;
}

function refusal(bytes: Uint8Array): string {
  try {
    readKtx2(bytes);
  } catch (error) {
    if (error instanceof Ktx2Error) return error.code;
    throw error;
  }
  return 'accepted';
}

describe('readKtx2 (ADR 0020 rule 4)', () => {
  it('reads an ETC1S file: kind, size, chain, alpha and transfer function', () => {
    const info = readKtx2(ktx2File({ channels: [0, 15] }));
    expect(info).toMatchObject({ widthPx: 256, heightPx: 256, levelCount: 9, kind: 'etc1s', hasAlpha: true });
    expect(info).toMatchObject({ srgb: true, blockReady: true });
    expect(readKtx2(ktx2File({ scheme: 2, model: 166, channels: [0], transfer: 1 }))).toMatchObject({
      kind: 'uastc',
      hasAlpha: false,
      srgb: false,
    });
    expect(readKtx2(ktx2File({ levels: 1 })).blockReady).toBe(false);
    expect(readKtx2(ktx2File({ widthPx: 250, heightPx: 250, levels: 8 })).blockReady).toBe(false);
  });

  it('refuses malformed files as invalid and valid files it cannot use as unsupported', () => {
    const good = ktx2File();
    expect(isKtx2(good)).toBe(true);
    expect(isKtx2(good.subarray(0, 8))).toBe(false);
    expect(refusal(new Uint8Array(100))).toBe('invalid');
    expect(refusal(good.subarray(0, 60))).toBe('invalid');
    // The last level's data runs past the end.
    expect(refusal(good.subarray(0, good.length - 1))).toBe('invalid');
    expect(refusal(ktx2File({ widthPx: 0 }))).toBe('invalid');
    expect(refusal(ktx2File({ levels: 10 }))).toBe('invalid');
    expect(refusal(ktx2File({ faces: 6 }))).toBe('unsupported');
    expect(refusal(ktx2File({ widthPx: 4096, heightPx: 4096, levels: 1 }))).toBe('unsupported');
    expect(refusal(ktx2File({ vkFormat: 97, scheme: 0 }))).toBe('unsupported');
    const huge = ktx2File();
    new DataView(huge.buffer).setUint32(80 + 4, 1, true);
    expect(refusal(huge)).toBe('invalid');
    // KB-068: a level that would make the transcoder allocate more than its blocks need.
    const inflated = ktx2File({ scheme: 2, model: 166 });
    new DataView(inflated.buffer).setUint32(80 + 16, 256 * 1024 * 1024, true);
    expect(refusal(inflated)).toBe('invalid');
  });

  it('passes raw blocks through only to devices that decode them', () => {
    const bytes = ktx2File({ vkFormat: 146, scheme: 0, model: 128, levelBytes: (level) => 16 * (level + 1) });
    const info = readKtx2(bytes);
    expect(info).toMatchObject({ kind: 'raw', rawTarget: 'bc7', hasAlpha: true, srgb: true });
    expect(chooseKtx2Target(info, ['bc'])).toBe('bc7');
    expect(chooseKtx2Target(info, ['etc2', 'astc'])).toBeUndefined();
    expect(ktx2LevelRange(bytes, 1)[1]).toBe(32);
    expect(chooseKtx2Target(readKtx2(ktx2File({ vkFormat: 43, scheme: 0, model: 1 })), [])).toBe('rgba8');
  });
});

describe('chooseKtx2Target (ADR 0020 rule 3)', () => {
  const etc1s = readKtx2(ktx2File());
  const etc1sAlpha = readKtx2(ktx2File({ channels: [0, 15] }));
  const uastc = readKtx2(ktx2File({ scheme: 0, model: 166 }));
  const uastcAlpha = readKtx2(ktx2File({ scheme: 0, model: 166, channels: [3] }));

  it.each([
    [etc1s, ['bc', 'etc2', 'astc'], 'bc1'],
    [etc1sAlpha, ['bc'], 'bc7'],
    [etc1s, ['etc2', 'astc'], 'etc2-rgb'],
    [etc1sAlpha, ['etc2'], 'etc2-rgba'],
    [etc1s, ['astc'], 'astc-4x4'],
    [etc1s, [], 'rgba8'],
    [uastc, ['bc', 'astc'], 'bc7'],
    [uastc, ['etc2', 'astc'], 'astc-4x4'],
    [uastcAlpha, ['etc2'], 'etc2-rgba'],
    [uastc, [], 'rgba8'],
  ] as const)('%# picks %s', (info, formats, target) => {
    expect(chooseKtx2Target(info, formats)).toBe(target);
  });

  it('counts exact GPU bytes: the file chain in blocks, or RGBA8 with a generated chain', () => {
    expect(ktx2GpuBytes(etc1s, 'bc1')).toBe(43_704);
    expect(ktx2GpuBytes(etc1s, 'bc7')).toBe(87_408);
    expect(ktx2GpuBytes(etc1s, 'rgba8')).toBe(349_524);
    // A file that cannot keep its chain is transcoded to RGBA8 whatever the device decodes.
    expect(chooseKtx2Target(readKtx2(ktx2File({ levels: 1 })), ['bc'])).toBe('rgba8');
  });
});
