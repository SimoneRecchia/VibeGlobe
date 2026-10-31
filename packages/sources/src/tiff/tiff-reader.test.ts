import { describe, expect, it } from 'vitest';
import { readTiff } from './tiff-reader.js';

describe('readTiff on untrusted bytes', () => {
  it('refuses tags that together claim more values than a TIFF needs, instead of reading them all', () => {
    // 4096 tags of a million bytes each, all at the same offset of a 1 MiB file: 4·10⁹ values to read.
    const tags = 4096;
    const file = new Uint8Array(1 << 20);
    const view = new DataView(file.buffer);
    file.set([0x49, 0x49]);
    view.setUint16(2, 42, true);
    view.setUint32(4, 8, true);
    view.setUint16(8, tags, true);
    for (let i = 0; i < tags; i++) {
      const entry = 10 + i * 12;
      view.setUint16(entry, 40_000 + i, true);
      view.setUint16(entry + 2, 1, true);
      view.setUint32(entry + 4, 1_000_000, true);
      view.setUint32(entry + 8, 8, true);
    }
    const startMs = performance.now();
    expect(() => readTiff(file)).toThrow(/values/);
    expect(performance.now() - startMs).toBeLessThan(1000);
  });
});
