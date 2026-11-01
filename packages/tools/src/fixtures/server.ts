// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * A local HTTP server for sample builds and tests (`vibeglobe-data fixtures serve`): the synthetic Sentinel-2 cloudless
 * stub, a synthetic OpenStreetMap extract, synthetic XYZ tiles and, optionally, a static folder served like any plain
 * static host (CORS, byte ranges, MIME types). Every request is logged and listed at `/__log`.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { syntheticOsmExtract } from './osm-sample.js';
import { syntheticWorld, syntheticXyzTile } from './synthetic.js';

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.pbf': 'application/x-protobuf',
  '.json': 'application/json',
  '.pmtiles': 'application/octet-stream',
  '.mbtiles': 'application/vnd.sqlite3',
  '.tif': 'image/tiff',
  '.js': 'text/javascript',
  '.html': 'text/html',
};

/** Options of the fixture server. */
export interface FixtureServerOptions {
  port: number;
  /** A folder served under `/static/`. */
  staticFolder?: string;
}

function send(request: IncomingMessage, response: ServerResponse, body: Uint8Array, type: string): void {
  response.writeHead(200, { 'content-type': type, 'content-length': body.length, 'access-control-allow-origin': '*' });
  response.end(request.method === 'HEAD' ? undefined : body);
}

function serveStatic(request: IncomingMessage, response: ServerResponse, root: string, path: string): void {
  const file = normalize(join(root, decodeURIComponent(path)));
  if (!file.startsWith(normalize(root)) || !existsSync(file) || statSync(file).isDirectory()) {
    response.writeHead(404, { 'access-control-allow-origin': '*' }).end();
    return;
  }
  const size = statSync(file).size;
  const headers = {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'content-length, content-range, etag',
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=86400',
  };
  const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range ?? '');
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
    response.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': end - start + 1,
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(file, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, { ...headers, 'content-length': size });
  if (request.method === 'HEAD') response.end();
  else createReadStream(file).pipe(response);
}

/** Starts the server; resolves with it and its request log once listening. */
export function startFixtureServer(
  options: FixtureServerOptions,
): Promise<{ server: Server; log: string[]; url: string }> {
  const log: string[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://fixture').pathname;
    if (path === '/__log')
      return send(request, response, new TextEncoder().encode(JSON.stringify(log)), 'application/json');
    log.push(`${request.method ?? 'GET'} ${path}`);
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'range' }).end();
      return;
    }
    const xyz = /^\/xyz\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(path);
    if (xyz)
      return send(request, response, syntheticXyzTile(Number(xyz[1]), Number(xyz[2]), Number(xyz[3])), 'image/png');
    if (path === '/world.tif') return send(request, response, syntheticWorld(2048), 'image/tiff');
    if (/^\/osm\/[\w.-]+\.osm\.pbf$/.test(path))
      return send(request, response, syntheticOsmExtract(), 'application/octet-stream');
    if (options.staticFolder && path.startsWith('/static/'))
      return serveStatic(request, response, options.staticFolder, path.slice('/static/'.length));
    response.writeHead(404, { 'access-control-allow-origin': '*' }).end();
  });
  return new Promise((resolve) => {
    server.listen(options.port, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : options.port;
      resolve({ server, log, url: `http://127.0.0.1:${port}` });
    });
  });
}
