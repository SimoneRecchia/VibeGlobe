// The fixture tile server (M3 plan §4.1) as a Node middleware: the playground's Vite plugin and the standalone
// servers mount it. Tiles: GET /fixture-tiles/{session}/{source}/{scheme}/{z}/{x}/{y}.{png,etc1s.ktx2,uastc.ktx2}
// with source one of the patterns (KTX2 tiles have a full mip chain, ADR 0020). Per-session fault rules: POST /_fixture/{session}/rules; request log: GET /_fixture/{session}/log;
// DELETE /_fixture/{session} resets both. A session id per test keeps tests independent.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { encodeKtx2 } from './ktx2.ts';
import {
  encodeTilePng,
  renderTile,
  tileExists,
  type FixturePattern,
  type FixtureScheme,
  type FixtureTile,
} from './generate.ts';

/** A fault applied to the tiles it matches (all given conditions must hold); the first matching rule applies. */
export interface FaultRule {
  source?: string;
  minLevel?: number;
  maxLevel?: number;
  /** Inclusive column and row ranges. */
  xRange?: [number, number];
  yRange?: [number, number];
  /** Delay before the response starts. */
  latencyMs?: number;
  /** Respond with this status and no image. */
  status?: number;
  /** With `status`: only the first N matching requests fail, later ones succeed. */
  failTimes?: number;
  /** Never respond (until the client gives up). */
  hang?: boolean;
  /** Send only the first N bytes of the image. */
  truncateBytes?: number;
  /** Send this many pseudo-random bytes instead of the image. */
  randomBytes?: number;
  /** Override the Content-Type header. */
  contentType?: string;
  /** A Retry-After header, in seconds. */
  retryAfterS?: number;
  /** Send the body at this rate, in bytes per second. */
  bandwidthBytesPerS?: number;
  /** Send the body gzip-compressed with `Content-Encoding: gzip`. */
  gzip?: boolean;
}

/** One request as the server saw it. */
export interface RequestRecord {
  path: string;
  source: string;
  level: number;
  x: number;
  y: number;
  startMs: number;
  endMs?: number;
  aborted?: boolean;
  status?: number;
  bytes?: number;
  /** The Host (or HTTP/2 :authority) the request was made to. */
  host?: string;
  /** The connection (HTTP/1.1 socket or HTTP/2 session) the request came on, numbered per server. */
  connection?: number;
}

interface Session {
  rules: FaultRule[];
  /** How many requests each rule has matched, for `failTimes`. */
  hits: number[];
  log: RequestRecord[];
}

const PATTERNS: readonly string[] = ['world', 'levels', 'border', 'smooth', 'tiles', 'stripes', 'patches'];
const SCHEMES: readonly string[] = ['mercator', 'geographic'];
const TILE_PATH = /^\/fixture-tiles\/([\w-]+)\/([\w-]+)\/([\w-]+)\/(\d+)\/(\d+)\/(\d+)\.(png|etc1s\.ktx2|uastc\.ktx2)$/;
const CONTROL_PATH = /^\/_fixture\/([\w-]+)(?:\/(rules|log))?$/;

function matches(rule: FaultRule, source: string, tile: FixtureTile): boolean {
  return (
    (rule.source === undefined || rule.source === source) &&
    (rule.minLevel === undefined || tile.level >= rule.minLevel) &&
    (rule.maxLevel === undefined || tile.level <= rule.maxLevel) &&
    (rule.xRange === undefined || (tile.x >= rule.xRange[0] && tile.x <= rule.xRange[1])) &&
    (rule.yRange === undefined || (tile.y >= rule.yRange[0] && tile.y <= rule.yRange[1]))
  );
}

/** Serves fixture tiles with per-session faults and request logs. */
export class FixtureServer {
  private readonly sessions = new Map<string, Session>();
  private readonly cache = new Map<string, Buffer>();
  private readonly connections = new Map<object, number>();

  private readonly now: () => number;

  /** `now` is injectable for tests. */
  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  /** The connect-style middleware: handles fixture paths and passes every other request to `next`. */
  readonly middleware = (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const url = new URL(req.url ?? '/', 'http://fixture');
    const control = CONTROL_PATH.exec(url.pathname);
    if (control) {
      this.control(control[1] ?? '', control[2], req, res);
      return;
    }
    const match = TILE_PATH.exec(url.pathname);
    if (match) this.tile(url.pathname, match, req, res);
    else next();
  };

  /** A number per connection: HTTP/2 requests share their session's, HTTP/1.1 requests their socket's. */
  private connectionOf(req: IncomingMessage): number {
    const stream = (req as IncomingMessage & { stream?: { session?: object } }).stream;
    const key: object = stream?.session ?? req.socket;
    let id = this.connections.get(key);
    if (id === undefined) this.connections.set(key, (id = this.connections.size + 1));
    return id;
  }

  private session(id: string): Session {
    let entry = this.sessions.get(id);
    if (!entry) this.sessions.set(id, (entry = { rules: [], hits: [], log: [] }));
    return entry;
  }

  private control(id: string, kind: string | undefined, req: IncomingMessage, res: ServerResponse): void {
    if (req.method === 'DELETE' && kind === undefined) {
      this.sessions.delete(id);
      res.writeHead(204).end();
    } else if (req.method === 'GET' && kind === 'log') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(this.session(id).log));
    } else if (req.method === 'POST' && kind === 'rules') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => this.setRules(id, Buffer.concat(chunks).toString('utf8'), res));
    } else {
      res.writeHead(405).end();
    }
  }

  private setRules(id: string, body: string, res: ServerResponse): void {
    try {
      const rules = JSON.parse(body) as unknown;
      if (!Array.isArray(rules)) throw new TypeError('rules must be an array');
      const entry = this.session(id);
      entry.rules = rules as FaultRule[];
      entry.hits = rules.map(() => 0);
      res.writeHead(204).end();
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end(String(error));
    }
  }

  private tile(path: string, match: RegExpExecArray, req: IncomingMessage, res: ServerResponse): void {
    const [, id = '', source = '', scheme = '', z = '0', x = '0', y = '0', extension = 'png'] = match;
    const entry = this.session(id);
    const tile: FixtureTile = {
      pattern: source as FixturePattern,
      scheme: scheme as FixtureScheme,
      level: Number(z),
      x: Number(x),
      y: Number(y),
    };
    const host = req.headers.host ?? String(req.headers[':authority'] ?? '');
    const record: RequestRecord = {
      path,
      source,
      level: tile.level,
      x: tile.x,
      y: tile.y,
      startMs: this.now(),
      host,
      connection: this.connectionOf(req),
    };
    entry.log.push(record);
    res.on('close', () => {
      if (record.endMs !== undefined) return;
      record.aborted = true;
      record.endMs = this.now();
    });
    if (!PATTERNS.includes(source) || !SCHEMES.includes(scheme) || !tileExists(tile)) {
      this.finish(record, res, 404, {}, Buffer.alloc(0));
      return;
    }
    const ruleIndex = entry.rules.findIndex((rule) => matches(rule, source, tile));
    const rule = entry.rules[ruleIndex];
    const respond = async (): Promise<void> => {
      if (res.destroyed || rule?.hang) return;
      const hits = (entry.hits[ruleIndex] ?? 0) + 1;
      if (rule) entry.hits[ruleIndex] = hits;
      const headers: Record<string, string> = {};
      if (rule?.retryAfterS !== undefined) headers['Retry-After'] = String(rule.retryAfterS);
      if (rule?.status !== undefined && (rule.failTimes === undefined || hits <= rule.failTimes)) {
        this.finish(record, res, rule.status, headers, Buffer.alloc(0));
        return;
      }
      headers['Content-Type'] = rule?.contentType ?? (extension === 'png' ? 'image/png' : 'image/ktx2');
      let body = await this.body(tile, extension, rule);
      if (rule?.gzip) {
        body = gzipSync(body);
        headers['Content-Encoding'] = 'gzip';
      }
      this.finish(record, res, 200, headers, body, rule?.bandwidthBytesPerS);
    };
    if (rule?.latencyMs) setTimeout(() => void respond(), rule.latencyMs);
    else void respond();
  }

  private async body(tile: FixtureTile, extension: string, rule: FaultRule | undefined): Promise<Buffer> {
    const key = `${tile.pattern}/${tile.scheme}/${tile.level}/${tile.x}/${tile.y}.${extension}`;
    let body = this.cache.get(key);
    if (!body) {
      body =
        extension === 'png'
          ? encodeTilePng(tile)
          : await encodeKtx2(renderTile(tile), 256, 256, extension === 'uastc.ktx2' ? 'uastc' : 'etc1s');
      this.cache.set(key, body);
    }
    if (rule?.randomBytes !== undefined) {
      body = Buffer.from(Array.from({ length: rule.randomBytes }, (_, i) => Math.imul(i + 1, 2654435761) >>> 24));
    }
    return rule?.truncateBytes !== undefined ? body.subarray(0, rule.truncateBytes) : body;
  }

  private finish(
    record: RequestRecord,
    res: ServerResponse,
    status: number,
    headers: Record<string, string>,
    body: Buffer,
    bandwidthBytesPerS?: number,
  ): void {
    record.status = status;
    record.bytes = body.length;
    res.writeHead(status, {
      ...headers,
      'Access-Control-Allow-Origin': '*',
      'Timing-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'Content-Length': String(body.length),
    });
    if (!bandwidthBytesPerS) {
      record.endMs = this.now();
      res.end(body);
      return;
    }
    // A tenth of a second's worth of bytes every 100 ms.
    const chunk = Math.max(1, Math.round(bandwidthBytesPerS / 10));
    let offset = 0;
    const send = (): void => {
      if (res.destroyed) return;
      const end = Math.min(body.length, offset + chunk);
      res.write(body.subarray(offset, end));
      offset = end;
      if (offset < body.length) {
        setTimeout(send, 100);
      } else {
        record.endMs = this.now();
        res.end();
      }
    };
    send();
  }
}
