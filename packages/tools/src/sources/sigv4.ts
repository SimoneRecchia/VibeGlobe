/**
 * AWS Signature Version 4 for S3 GET requests to requester-pays buckets. Credentials come only from the environment
 * (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional `AWS_SESSION_TOKEN`); nothing is stored.
 */
import { createHash, createHmac } from 'node:crypto';

/** AWS credentials. */
export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** Reads credentials from the environment, or `undefined` when they are not set. */
export function credentialsFromEnv(env: Record<string, string | undefined> = process.env): AwsCredentials | undefined {
  const accessKeyId = env['AWS_ACCESS_KEY_ID'];
  const secretAccessKey = env['AWS_SECRET_ACCESS_KEY'];
  if (!accessKeyId || !secretAccessKey) return undefined;
  const sessionToken = env['AWS_SESSION_TOKEN'];
  return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function hmac(key: Buffer | string, text: string): Buffer {
  return createHmac('sha256', key).update(text).digest();
}

/** The region of an S3 virtual-hosted URL (`bucket.s3.<region>.amazonaws.com`), defaulting to us-east-1. */
function s3Region(url: URL): string {
  return /\.s3[.-]([a-z0-9-]+)\.amazonaws\.com$/.exec(url.hostname)?.[1] ?? 'us-east-1';
}

/** Headers that sign an S3 GET of `url` at `now`; `extra` headers (range, request payer) are signed too. */
export function signS3Get(
  url: URL,
  credentials: AwsCredentials,
  now: Date,
  extra: Record<string, string> = {},
): Record<string, string> {
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const region = s3Region(url);
  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': sha256Hex(''),
    'x-amz-date': amzDate,
    ...(credentials.sessionToken ? { 'x-amz-security-token': credentials.sessionToken } : {}),
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k.toLowerCase(), v])),
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${(headers[name] ?? '').trim()}\n`).join('');
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .sort()
    .join('&');
  const request = ['GET', url.pathname, query, canonicalHeaders, names.join(';'), headers['x-amz-content-sha256']].join(
    '\n',
  );
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(request)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  const sent = Object.fromEntries(Object.entries(headers).filter(([name]) => name !== 'host'));
  return {
    ...sent,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}
