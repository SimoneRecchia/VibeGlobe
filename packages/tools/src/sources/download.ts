/** The download step: resumable HTTP downloads with checksums (F335) and requester-pays signing. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type StepLog, sha256, writeAtomic } from '../pipeline/step-log.js';
import type { SourceFile } from './files.js';
import { type AwsCredentials, signS3Get } from './sigv4.js';

/** What the download step needs from its surroundings; tests inject `fetch`. */
export interface DownloadContext {
  folder: string;
  log: StepLog;
  fetch: typeof fetch;
  credentials?: AwsCredentials;
  /** Expected SHA-256 per file key, from the configuration's lock file. */
  lock: Record<string, string>;
  report: (line: string) => void;
  /** First retry delay after a network error (doubled on each retry); tests set it to 0. */
  retryDelayMs?: number;
}

/** Outcome of one file. */
export interface DownloadResult {
  key: string;
  status: 'skipped' | 'downloaded' | 'missing';
  /** Bytes transferred over the network by this run. */
  transferred: number;
  sha256?: string;
}

const STEP = 'download';
const MISSING = 'missing';

async function request(file: SourceFile, context: DownloadContext, offset: number): Promise<Response> {
  const headers: Record<string, string> = offset > 0 ? { range: `bytes=${offset}-` } : {};
  if (file.requesterPays) {
    if (!context.credentials)
      throw new Error(`${file.url}: requester-pays source needs AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY`);
    Object.assign(
      headers,
      signS3Get(new URL(file.url), context.credentials, new Date(), { ...headers, 'x-amz-request-payer': 'requester' }),
    );
  }
  return fetchWithRetry(context, file.url, headers);
}

/**
 * Fetches with up to three retries on network errors (a reset connection, a dropped proxy), waiting 1, 2 and 4 s; an
 * HTTP error status is returned, not retried.
 */
async function fetchWithRetry(
  context: DownloadContext,
  url: string,
  headers: Record<string, string>,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await context.fetch(url, { headers });
    } catch (error) {
      if (attempt >= 3) throw error;
      context.report(`network error on ${url} (${String((error as Error).cause ?? error)}); retrying`);
      await new Promise((resolve) => setTimeout(resolve, (context.retryDelayMs ?? 1000) * 2 ** attempt));
    }
  }
}

/** Appends the response body to `path` chunk by chunk, so an interrupted download keeps what arrived. */
async function streamTo(response: Response, path: string): Promise<number> {
  let total = 0;
  if (!response.body) return total;
  for await (const chunk of response.body) {
    appendFileSync(path, chunk);
    total += chunk.length;
  }
  return total;
}

/** Downloads one file into `<folder>/<key>`, resuming a partial download, verifying the lock checksum. */
export async function downloadFile(file: SourceFile, context: DownloadContext): Promise<DownloadResult> {
  const target = join(context.folder, file.key);
  if (context.log.logged(STEP, file.key) === MISSING) return { key: file.key, status: 'missing', transferred: 0 };
  const state = context.log.check(STEP, file.key, target);
  if (state === 'done') {
    context.report(`skip ${file.key} (checksum verified)`);
    return { key: file.key, status: 'skipped', transferred: 0 };
  }
  if (state === 'corrupt') {
    context.report(`corrupt ${file.key}: checksum mismatch, downloading again`);
    rmSync(target, { force: true });
  }
  const partial = `${target}.download`;
  const offset = existsSync(partial) ? statSync(partial).size : 0;
  const response = await request(file, context, offset);
  if (response.status === 404 && file.mayBeMissing) {
    context.log.record(STEP, file.key, MISSING);
    context.report(`missing ${file.key} (no data there)`);
    return { key: file.key, status: 'missing', transferred: 0 };
  }
  if (!response.ok) throw new Error(`${file.url}: HTTP ${response.status}`);
  mkdirSync(dirname(partial), { recursive: true });
  // A server that ignores the range answers 200 with the whole file: start over.
  if (response.status !== 206) rmSync(partial, { force: true });
  const transferred = await streamTo(response, partial);
  const bytes = readFileSync(partial);
  const checksum = sha256(bytes);
  const expected = context.lock[file.key];
  if (expected !== undefined && expected !== checksum) {
    rmSync(partial, { force: true });
    throw new Error(`${file.key}: SHA-256 ${checksum} does not match the lock file (${expected})`);
  }
  writeAtomic(target, bytes);
  rmSync(partial, { force: true });
  context.log.record(STEP, file.key, checksum);
  context.report(`downloaded ${file.key} (${bytes.length} bytes${offset > 0 ? `, resumed at ${offset}` : ''})`);
  return { key: file.key, status: 'downloaded', transferred, sha256: checksum };
}

/** Downloads every file in order; returns per-file results. */
export async function downloadAll(files: SourceFile[], context: DownloadContext): Promise<DownloadResult[]> {
  const results: DownloadResult[] = [];
  for (const file of files) results.push(await downloadFile(file, context));
  return results;
}
