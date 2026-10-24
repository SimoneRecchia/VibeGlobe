import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TaskError, type TaskContext } from './protocol.js';
import { createTranscodeKtx2 } from './transcode-ktx2.js';

/** The fixture encoder (test tooling outside the package), loaded by URL so the package's build never sees it. */
const ENCODER = new URL('../../../scripts/fixtures/tiles/ktx2.ts', import.meta.url).href;
type Encode = (rgba: Uint8Array, widthPx: number, heightPx: number, mode: 'etc1s' | 'uastc') => Promise<Buffer>;

const context = { isCancelled: () => false } as TaskContext;

describe('transcode-ktx2', { timeout: 30_000 }, () => {
  it('loads the transcoder again on a later task after a failed load (TH-01)', async () => {
    const { encodeKtx2 } = (await import(/* @vite-ignore */ ENCODER)) as { encodeKtx2: Encode };
    const file = await encodeKtx2(new Uint8Array(16 * 16 * 4).fill(200), 16, 16, 'etc1s');
    const input = (): { bytes: ArrayBuffer; formats: string[] } => ({
      bytes: file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer,
      formats: [],
    });
    let loads = 0;
    const transcode = createTranscodeKtx2(() => {
      loads++;
      // A reset connection while fetching the WebAssembly, once; then the file loads.
      if (loads === 1) return Promise.reject(new Error('connection reset'));
      return WebAssembly.compile(readFileSync(new URL('../wasm/vibeglobe-basis.wasm', import.meta.url)));
    });
    await expect(transcode(input(), context)).rejects.toBeInstanceOf(TaskError);
    const result = await transcode(input(), context);
    expect(loads).toBe(2);
    expect(result.output).toMatchObject({ widthPx: 16, heightPx: 16 });
  });
});
