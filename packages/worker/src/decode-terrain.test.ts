import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { gunzip } from './decode-terrain.js';
import { TaskError } from './protocol.js';

describe('gunzip', () => {
  it('inflates gzip-compressed bytes (F127)', async () => {
    const bytes = Uint8Array.from({ length: 100_000 }, (_, i) => i % 251);
    const inflated = await gunzip(new Uint8Array(gzipSync(bytes)));
    expect(inflated).toEqual(bytes);
  });

  it('fails with undecodable once the output passes the limit, without inflating the rest (F131)', async () => {
    // 64 MB of zeros compress to about 64 KB: a gzip bomb against a 1 MB limit.
    const bomb = new Uint8Array(gzipSync(new Uint8Array(64 * 1024 * 1024)));
    const failure = gunzip(bomb, 1024 * 1024);
    await expect(failure).rejects.toBeInstanceOf(TaskError);
    await expect(failure).rejects.toMatchObject({ code: 'undecodable' });
  });
});
