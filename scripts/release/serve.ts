// A static server for the consumer projects' builds (F503, F531, F532, F559): serves a folder under the strict
// Content Security Policy of F100 (no 'unsafe-eval' anywhere; WebAssembly compiles only in the worker, under
// 'wasm-unsafe-eval'), the fixture tiles, and optionally forwards a path prefix to another server, the way a
// consumer puts engine assets from a separate static server on its own origin.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import { FixtureServer } from '../fixtures/tiles/server.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/** The page's policy: nothing evaluated, scripts and workers only from the page's origin. */
const PAGE_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
].join('; ');
/** A worker follows the policy of its own script's response: WebAssembly compiles there and nothing is evaluated. */
const WORKER_POLICY = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'";

export interface SiteOptions {
  /** Requests under `prefix` go to the server at `target` (an origin), with the prefix removed. */
  readonly forward?: { readonly prefix: string; readonly target: string };
  /** Allow inline scripts on the page ('unsafe-inline', still never 'unsafe-eval'), for Nuxt's inline configuration. */
  readonly inlineScripts?: boolean;
  /** Serve the fixture tiles under `/fixture-tiles/` (default true). */
  readonly tiles?: boolean;
}

export interface Site {
  readonly url: string;
  /** Request paths in arrival order. */
  readonly requests: string[];
  close(): Promise<void>;
}

function sendFile(root: string, pathname: string, res: ServerResponse, pagePolicy: string): void {
  const path = normalize(join(root, decodeURIComponent(pathname)));
  const file =
    path.startsWith(root + sep) && existsSync(path) && statSync(path).isDirectory() ? join(path, 'index.html') : path;
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404).end();
    return;
  }
  const headers: Record<string, string> = { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' };
  if (file.endsWith('.html')) headers['content-security-policy'] = pagePolicy;
  if (/vibeglobe-worker[^/]*\.js$/.test(file)) headers['content-security-policy'] = WORKER_POLICY;
  res.writeHead(200, headers);
  createReadStream(file).pipe(res);
}

function forward(target: string, path: string, req: IncomingMessage, res: ServerResponse): void {
  // A fresh connection per request: a kept-alive socket the other server closes as idle would reset a request sent on
  // it in the same moment, and the browser would see the response aborted.
  const options = { method: req.method, headers: { ...req.headers, connection: 'close' }, agent: false };
  const upstream = request(new URL(path, target), options, (answer) => {
    res.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(res);
  });
  upstream.on('error', () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
  req.pipe(upstream);
}

/** Serves `root` on a free port of 127.0.0.1. */
export async function serveSite(root: string, options: SiteOptions = {}): Promise<Site> {
  const fixtures = new FixtureServer();
  const requests: string[] = [];
  const pagePolicy = options.inlineScripts
    ? PAGE_POLICY.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
    : PAGE_POLICY;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    requests.push(url.pathname);
    const { forward: route } = options;
    if (route && url.pathname.startsWith(route.prefix)) {
      forward(route.target, `/${url.pathname.slice(route.prefix.length)}${url.search}`, req, res);
      return;
    }
    if (options.tiles !== false && url.pathname.startsWith('/fixture-tiles/')) {
      fixtures.middleware(req as never, res as never, () => res.writeHead(404).end());
      return;
    }
    sendFile(normalize(root), url.pathname, res, pagePolicy);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
