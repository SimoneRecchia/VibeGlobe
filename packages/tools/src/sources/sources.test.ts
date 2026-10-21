import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StepLog, sha256 } from '../pipeline/step-log.js';
import { type DownloadContext, downloadFile } from './download.js';
import { type SourceFile, copernicusDemName, s2FileExtentDeg } from './files.js';
import { signS3Get } from './sigv4.js';

const folders: string[] = [];
afterEach(() => folders.splice(0).forEach((f) => rmSync(f, { recursive: true, force: true })));

function context(fetchImpl: typeof fetch): DownloadContext & { lines: string[] } {
  const folder = mkdtempSync(join(tmpdir(), 'vg-download-'));
  folders.push(folder);
  const lines: string[] = [];
  return {
    folder,
    log: new StepLog(join(folder, 'steps.log')),
    fetch: fetchImpl,
    lock: {},
    report: (l) => lines.push(l),
    lines,
  };
}

const body = Uint8Array.from({ length: 1000 }, (_, i) => i & 255);
const file: SourceFile = { url: 'https://example.test/a.tif', key: 'a.tif', requesterPays: false, mayBeMissing: false };

/** A server that honors range requests and records them. */
function server(requests: (string | null)[]): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string> | undefined)?.['range'] ?? null;
    requests.push(range);
    const start = range ? Number(/bytes=(\d+)-/.exec(range)?.[1]) : 0;
    return new Response(body.slice(start), { status: range ? 206 : 200 });
  }) as typeof fetch;
}

describe('sources', () => {
  it('names Copernicus DEM tiles and Sentinel-2 cloudless metatiles', () => {
    expect(copernicusDemName(45, 6)).toBe('Copernicus_DSM_COG_10_N45_00_E006_00_DEM');
    expect(copernicusDemName(-1, -71, 3)).toBe('Copernicus_DSM_COG_30_S01_00_W071_00_DEM');
    expect(s2FileExtentDeg(13)).toBeCloseTo(180 / 4096, 12);
  });

  it('resumes a partial download with a range request and skips a verified file', async () => {
    const requests: (string | null)[] = [];
    const ctx = context(server(requests));
    writeFileSync(join(ctx.folder, 'a.tif.download'), body.slice(0, 400));
    const first = await downloadFile(file, ctx);
    expect(first).toMatchObject({ status: 'downloaded', transferred: 600, sha256: sha256(body) });
    expect(requests).toEqual(['bytes=400-']);
    expect(new Uint8Array(readFileSync(join(ctx.folder, 'a.tif')))).toEqual(body);
    expect(await downloadFile(file, ctx)).toMatchObject({ status: 'skipped', transferred: 0 });
    expect(requests).toHaveLength(1);
  });

  it('detects a corrupted download by checksum and downloads it again', async () => {
    const requests: (string | null)[] = [];
    const ctx = context(server(requests));
    await downloadFile(file, ctx);
    writeFileSync(join(ctx.folder, 'a.tif'), body.slice(0, 999));
    expect(await downloadFile(file, ctx)).toMatchObject({ status: 'downloaded', transferred: 1000 });
    expect(ctx.lines.some((l) => l.startsWith('corrupt a.tif'))).toBe(true);
  });

  it('refuses a file whose checksum differs from the lock file', async () => {
    const ctx = { ...context(server([])), lock: { 'a.tif': '0'.repeat(64) } };
    await expect(downloadFile(file, ctx)).rejects.toThrow(/does not match the lock file/);
  });

  it('signs S3 requests with AWS Signature Version 4 (AWS documentation example)', () => {
    const headers = signS3Get(
      new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
      new Date('2013-05-24T00:00:00Z'),
      { Range: 'bytes=0-9' },
    );
    expect(headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });
});
