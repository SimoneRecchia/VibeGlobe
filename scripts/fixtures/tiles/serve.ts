// Standalone fixture tile servers (M3 plan §4.1) for the end-to-end tests that need more than the playground's own
// origin: HTTP/1.1 on every local address, so `localhost` and `127.0.0.1` are two hosts (F089), and HTTP/2 over TLS
// with a certificate made at start for `localhost` (browsers speak HTTP/2 only over TLS; F096). Nothing is committed:
// the certificate and its key live in a temporary directory and secure nothing.
//
//   node scripts/fixtures/tiles/serve.ts [--port 5177] [--http2]
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createSecureServer } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FixtureServer } from './server.ts';

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1] || 5177);
const http2 = args.includes('--http2');
const fixtures = new FixtureServer();
const notFound = (res: { writeHead(status: number): { end(): void } }): void => res.writeHead(404).end();

if (http2) {
  const directory = mkdtempSync(join(tmpdir(), 'vibeglobe-fixture-tls-'));
  const key = join(directory, 'key.pem');
  const cert = join(directory, 'cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout',
      key,
      '-out',
      cert,
    ],
    { stdio: 'ignore' },
  );
  const server = createSecureServer(
    { key: readFileSync(key), cert: readFileSync(cert), allowHTTP1: true },
    (req, res) => fixtures.middleware(req as never, res as never, () => notFound(res)),
  );
  server.listen(port, () => console.log(`fixture tiles over HTTP/2 on https://localhost:${port}`));
} else {
  const server = createServer((req, res) => fixtures.middleware(req, res, () => notFound(res)));
  // Every local address: localhost and 127.0.0.1 reach the same server as two origins.
  server.listen(port, () => console.log(`fixture tiles over HTTP/1.1 on http://localhost:${port}`));
}
