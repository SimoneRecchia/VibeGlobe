import { readFileSync } from 'node:fs';
import { chooseKtx2Target, readKtx2, type CompressedTileImage, type Ktx2Target } from '@vibeglobe/core';
import { describe, expect, it } from 'vitest';
import { createTranscodeKtx2 } from '@vibeglobe/worker';
import { renderTile } from './generate.ts';
import { encodeKtx2, type Ktx2Mode } from './ktx2.ts';

/** The committed transcoder build, run in Node exactly as a worker runs it. */
const transcode = createTranscodeKtx2(() =>
  WebAssembly.compile(readFileSync(new URL('../../../packages/worker/wasm/vibeglobe-basis.wasm', import.meta.url))),
);
const context = { isCancelled: () => false };
const SIZE = 256;

interface Output {
  widthPx: number;
  heightPx: number;
  gpuBytes: number;
  image: CompressedTileImage | { data: Uint8Array; width: number; height: number };
}

async function run(file: Buffer, formats: string[]): Promise<Output> {
  const bytes = file.buffer.slice(file.byteOffset, file.byteOffset + file.length) as ArrayBuffer;
  return (await transcode({ bytes, formats }, context)).output as Output;
}

/** Peak signal-to-noise ratio of the RGB channels, in dB. */
function psnr(a: Uint8Array, b: Uint8Array): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = (a[i + c] ?? 0) - (b[i + c] ?? 0);
      sum += d * d;
      count++;
    }
  }
  return 10 * Math.log10((255 * 255) / (sum / count));
}

const source = renderTile({ pattern: 'world', scheme: 'mercator', level: 3, x: 4, y: 2, sizePx: SIZE });

describe('KTX2 fixtures through the committed transcoder (F104)', () => {
  const cases: [Ktx2Mode, string[], Ktx2Target][] = [
    ['etc1s', ['bc', 'etc2', 'astc'], 'bc1'],
    ['etc1s', ['etc2', 'astc'], 'etc2-rgb'],
    ['etc1s', [], 'rgba8'],
    ['uastc', ['bc'], 'bc7'],
    ['uastc', ['etc2', 'astc'], 'astc-4x4'],
    ['uastc', ['etc2'], 'etc2-rgb'],
    ['uastc', [], 'rgba8'],
  ];
  it.each(cases)('%s with %j transcodes to %s with exact byte accounting', async (mode, formats, target) => {
    const file = await encodeKtx2(source, SIZE, SIZE, mode);
    const info = readKtx2(file);
    expect(info).toMatchObject({ widthPx: SIZE, heightPx: SIZE, levelCount: 9, kind: mode, hasAlpha: false });
    expect(info).toMatchObject({ srgb: true, blockReady: true });
    expect(chooseKtx2Target(info, formats)).toBe(target);
    const output = await run(file, formats);
    if (target === 'rgba8') {
      const image = output.image as { data: Uint8Array };
      expect(output.gpuBytes).toBe(349_524);
      // Quality against the source: ETC1S is the lossier mode (ADR 0020, survey §5).
      expect(psnr(image.data, source)).toBeGreaterThan(mode === 'etc1s' ? 28 : 36);
      return;
    }
    const image = output.image as CompressedTileImage;
    expect(image.target).toBe(target);
    expect(image.srgb).toBe(true);
    expect(image.levels.map((level) => level.widthPx)).toEqual([256, 128, 64, 32, 16, 8, 4, 2, 1]);
    expect(output.gpuBytes).toBe(image.levels.reduce((sum, level) => sum + level.data.length, 0));
    // A quarter (16-byte blocks) or an eighth (8-byte blocks) of the RGBA8 chain.
    expect(output.gpuBytes).toBe(target === 'bc1' || target === 'etc2-rgb' ? 43_704 : 87_408);
  });

  it('keeps alpha: ETC1S with transparent pixels goes to BC7 or ETC2 RGBA', async () => {
    const rgba = source.slice();
    for (let i = 3; i < rgba.length; i += 8) rgba[i] = 0;
    const file = await encodeKtx2(rgba, SIZE, SIZE, 'etc1s');
    const info = readKtx2(file);
    expect(info.hasAlpha).toBe(true);
    expect(chooseKtx2Target(info, ['bc'])).toBe('bc7');
    expect(chooseKtx2Target(info, ['etc2'])).toBe('etc2-rgba');
    expect(((await run(file, ['bc'])).image as CompressedTileImage).target).toBe('bc7');
  });

  it('a file that is not a multiple of 4 keeps no chain: RGBA8 with GPU mipmaps', async () => {
    const width = 250;
    const rgba = renderTile({ pattern: 'world', scheme: 'mercator', level: 3, x: 4, y: 2, sizePx: width });
    const file = await encodeKtx2(rgba, width, width, 'etc1s');
    expect(readKtx2(file).blockReady).toBe(false);
    const output = await run(file, ['bc']);
    expect((output.image as { width: number }).width).toBe(width);
  });

  it('a truncated file fails as undecodable, a missing transcoder as format-unsupported', async () => {
    const file = await encodeKtx2(source, SIZE, SIZE, 'uastc');
    await expect(run(file.subarray(0, file.length - 100), ['bc'])).rejects.toMatchObject({ code: 'undecodable' });
    const broken = createTranscodeKtx2(() => Promise.reject(new Error('refused by the policy')));
    const bytes = new Uint8Array(file).buffer;
    await expect(broken({ bytes, formats: ['bc'] }, context)).rejects.toMatchObject({ code: 'format-unsupported' });
  });
});
