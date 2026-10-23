// The fixture tile server (M3 plan §4.1) as a Node middleware: the playground's Vite plugin and the standalone
// servers mount it. Tiles: GET /fixture-tiles/{session}/{source}/{scheme}/{z}/{x}/{y}.{png,etc1s.ktx2,uastc.ktx2}
// with source one of the patterns (KTX2 tiles have a full mip chain, ADR 0020). Terrain (M4 plan §2): source `terrain`
// with {y}.terrarium.png, .terrain-rgb.png, .f32, .rgb24 (rows from the north) or .terrain (quantized-mesh, TMS rows from the
// south), source `terrain-geoid` for the same heights above the fixture geoid, GET /fixture-geoid.bin for that geoid
// (VGEOID1), and GET /fixture-tiles/{session}/terrain/{scheme}/layer.json. Per-session fault rules: POST
// /_fixture/{session}/rules; the session's layer.json: POST /_fixture/{session}/layer; request log: GET
// /_fixture/{session}/log; DELETE /_fixture/{session} resets all three. A session id per test keeps tests independent.
// UTM imagery (F226): GET /fixture-tiles/{session}/wms-utm?CRS=EPSG:32632&BBOX=minx,miny,maxx,maxy&WIDTH=..&HEIGHT=..
// (WMS 1.3.0 parameters, EPSG:32632 or EPSG:32633), logged with source `wms-utm` and the query in `path`.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { encodeKtx2 } from './ktx2.ts';
import { fixtureGeoidFile, terrainTile, type QuantizedMeshExtensions, type TerrainEncoding } from './terrain.ts';
import {
  encodeTilePng,
  renderTile,
  tileExists,
  type FixturePattern,
  type FixtureScheme,
  type FixtureTile,
} from './generate.ts';
import { encodeUtmPng, parseUtmRequest } from './utm.ts';

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
  /** Send the body gzip-compressed without `Content-Encoding`, as `.terrain` files often are (F127). */
  gzipBody?: boolean;
  /** Answer without CORS headers, so a page of another origin cannot read the tiles (F251). */
  noCors?: boolean;
  /** Answer 401 unless the request's Authorization header is exactly this (F252). */
  requireAuthorization?: string;
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
  /** The request's Accept header (quantized-mesh clients name the extensions they want in it, F128). */
  accept?: string;
  /** The Host (or HTTP/2 :authority) the request was made to. */
  host?: string;
  /** The connection (HTTP/1.1 socket or HTTP/2 session) the request came on, numbered per server. */
  connection?: number;
  /** The query string, `?` included, when the request had one (F253). */
  query?: string;
  /** The request's Authorization header (F252). */
  authorization?: string;
  /** Whether the request carried cookies (the fetch credentials mode, F251). */
  cookie?: boolean;
  /** The request's Sec-Fetch-Mode (`cors`, `no-cors`, …): tells a CORS probe from the request it checks (F251). */
  fetchMode?: string;
}

interface Session {
  rules: FaultRule[];
  /** How many requests each rule has matched, for `failTimes`. */
  hits: number[];
  log: RequestRecord[];
  /** The layer.json this session serves; a default with full availability when unset. */
  layer?: unknown;
}

const PATTERNS: readonly string[] = [
  'world',
  'levels',
  'border',
  'smooth',
  'tiles',
  'stripes',
  'patches',
  'red',
  'green',
  'blue',
  'shade',
];
const SCHEMES: readonly string[] = ['mercator', 'geographic'];
const TILE_PATH =
  /^\/fixture-tiles\/([\w-]+)\/([\w-]+)\/([\w-]+)\/(\d+)\/(\d+)\/(\d+)\.(png|etc1s\.ktx2|uastc\.ktx2|terrarium\.png|terrain-rgb\.png|terrain|f32|rgb24)$/;
const LAYER_PATH = /^\/fixture-tiles\/([\w-]+)\/terrain\/([\w-]+)\/layer\.json$/;
const WMS_UTM_PATH = /^\/fixture-tiles\/([\w-]+)\/wms-utm$/;
const CONTROL_PATH = /^\/_fixture\/([\w-]+)(?:\/(rules|log|layer))?$/;
/** Terrain file extensions and their encodings. */
const TERRAIN: Readonly<Record<string, TerrainEncoding>> = {
  'terrarium.png': 'terrarium',
  'terrain-rgb.png': 'terrain-rgb',
  terrain: 'quantized-mesh',
  f32: 'float32',
  rgb24: 'rgb24',
};
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  'terrarium.png': 'image/png',
  'terrain-rgb.png': 'image/png',
  terrain: 'application/vnd.quantized-mesh',
  f32: 'application/octet-stream',
  rgb24: 'application/octet-stream',
};

/** The default layer.json: every tile of levels 0–16 available, in TMS order, with no extensions. */
function defaultLayer(scheme: string): unknown {
  const geographic = scheme === 'geographic';
  return {
    tilejson: '2.1.0',
    format: 'quantized-mesh-1.0',
    version: '1.0.0',
    scheme: 'tms',
    tiles: ['{z}/{x}/{y}.terrain'],
    projection: geographic ? 'EPSG:4326' : 'EPSG:3857',
    minzoom: 0,
    maxzoom: 16,
    extensions: [],
    available: Array.from({ length: 17 }, (_, z) => [
      { startX: 0, startY: 0, endX: (geographic ? 2 : 1) * 2 ** z - 1, endY: 2 ** z - 1 },
    ]),
  };
}

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
  /**
   * The CORS answer of a tile response: the requesting origin, echoed so that requests with credentials are allowed
   * too (F251); undefined for a `noCors` rule, which answers without CORS headers. Absent: any origin (`*`).
   */
  private readonly cors = new WeakMap<ServerResponse, string | undefined>();

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
    if (url.pathname === '/fixture-geoid.bin') {
      const body = fixtureGeoidFile();
      res
        .writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Access-Control-Allow-Origin': '*',
          'Content-Length': String(body.length),
        })
        .end(body);
      return;
    }
    const layer = LAYER_PATH.exec(url.pathname);
    if (layer) {
      const body = JSON.stringify(this.session(layer[1] ?? '').layer ?? defaultLayer(layer[2] ?? ''));
      res
        .writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        })
        .end(body);
      return;
    }
    const utm = WMS_UTM_PATH.exec(url.pathname);
    if (utm) {
      this.utmImage(utm[1] ?? '', url, req, res);
      return;
    }
    const match = TILE_PATH.exec(url.pathname);
    if (match) this.tile(url.pathname, url.search, match, req, res);
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
    } else if (req.method === 'POST' && (kind === 'rules' || kind === 'layer')) {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (kind === 'rules') this.setRules(id, body, res);
        else this.setLayer(id, body, res);
      });
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

  private setLayer(id: string, body: string, res: ServerResponse): void {
    try {
      this.session(id).layer = JSON.parse(body) as unknown;
      res.writeHead(204).end();
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end(String(error));
    }
  }

  private tile(path: string, query: string, match: RegExpExecArray, req: IncomingMessage, res: ServerResponse): void {
    const [, id = '', source = '', scheme = '', z = '0', x = '0', y = '0', extension = 'png'] = match;
    const entry = this.session(id);
    const tile: FixtureTile = {
      pattern: source as FixturePattern,
      scheme: scheme as FixtureScheme,
      level: Number(z),
      x: Number(x),
      y: Number(y),
    };
    const record = this.recordOf(path, query, source, tile, req);
    entry.log.push(record);
    res.on('close', () => {
      if (record.endMs !== undefined) return;
      record.aborted = true;
      record.endMs = this.now();
    });
    // `terrain-geoid` serves the same terrain above the fixture geoid instead of the ellipsoid (F133).
    const terrain = (source === 'terrain' || source === 'terrain-geoid') && TERRAIN[extension] !== undefined;
    // Quantized-mesh rows count from the south (TMS); everything else from the north.
    if (terrain && extension === 'terrain') tile.y = 2 ** tile.level - 1 - tile.y;
    if ((!terrain && !PATTERNS.includes(source)) || !SCHEMES.includes(scheme) || !tileExists(tile)) {
      this.finish(record, res, 404, {}, Buffer.alloc(0));
      return;
    }
    const ruleIndex = entry.rules.findIndex((rule) => matches(rule, source, tile));
    const rule = entry.rules[ruleIndex];
    this.cors.set(res, rule?.noCors ? undefined : req.headers.origin);
    const respond = async (): Promise<void> => {
      if (res.destroyed || rule?.hang) return;
      const hits = (entry.hits[ruleIndex] ?? 0) + 1;
      if (rule) entry.hits[ruleIndex] = hits;
      const headers: Record<string, string> = {};
      if (rule?.retryAfterS !== undefined) headers['Retry-After'] = String(rule.retryAfterS);
      if (rule?.requireAuthorization !== undefined && req.headers.authorization !== rule.requireAuthorization) {
        this.finish(record, res, 401, headers, Buffer.alloc(0));
        return;
      }
      if (rule?.status !== undefined && (rule.failTimes === undefined || hits <= rule.failTimes)) {
        this.finish(record, res, rule.status, headers, Buffer.alloc(0));
        return;
      }
      headers['Content-Type'] = rule?.contentType ?? CONTENT_TYPES[extension] ?? 'image/ktx2';
      let body = await this.body(tile, extension, rule, this.meshExtensions(entry, tile, req.headers.accept));
      if (rule?.gzip) {
        body = gzipSync(body);
        headers['Content-Encoding'] = 'gzip';
      } else if (rule?.gzipBody) {
        body = gzipSync(body);
      }
      this.finish(record, res, 200, headers, body, rule?.bandwidthBytesPerS);
    };
    if (rule?.latencyMs) setTimeout(() => void respond(), rule.latencyMs);
    else void respond();
  }

  /** The log record of a tile request, with the headers the tests inspect. */
  private recordOf(
    path: string,
    query: string,
    source: string,
    tile: FixtureTile,
    req: IncomingMessage,
  ): RequestRecord {
    const host = req.headers.host ?? String(req.headers[':authority'] ?? '');
    return {
      path,
      source,
      level: tile.level,
      x: tile.x,
      y: tile.y,
      startMs: this.now(),
      host,
      connection: this.connectionOf(req),
      ...(req.headers.accept ? { accept: req.headers.accept } : {}),
      ...(query ? { query } : {}),
      ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
      cookie: req.headers.cookie !== undefined,
      ...(typeof req.headers['sec-fetch-mode'] === 'string' ? { fetchMode: req.headers['sec-fetch-mode'] } : {}),
    };
  }

  /** A GetMap image of the UTM fixture (F226), logged like a tile with level, column and row 0. */
  private utmImage(id: string, url: URL, req: IncomingMessage, res: ServerResponse): void {
    const record: RequestRecord = {
      path: url.pathname + url.search,
      source: 'wms-utm',
      level: 0,
      x: 0,
      y: 0,
      startMs: this.now(),
      host: req.headers.host ?? String(req.headers[':authority'] ?? ''),
      connection: this.connectionOf(req),
    };
    this.session(id).log.push(record);
    const request = parseUtmRequest(url.searchParams);
    if (request) this.finish(record, res, 200, { 'Content-Type': 'image/png' }, encodeUtmPng(request));
    else this.finish(record, res, 400, { 'Content-Type': 'text/plain' }, Buffer.from('bad GetMap request'));
  }

  /**
   * The quantized-mesh extensions a request gets: those its Accept header names, as a server does; the metadata only
   * where the session's layer.json lists some for the tile under `x-fixtureMetadata` (keyed `z/x/y`, TMS rows).
   */
  private meshExtensions(entry: Session, tile: FixtureTile, accept: string | undefined): QuantizedMeshExtensions {
    const names = /extensions=([\w-]+)/.exec(accept ?? '')?.[1]?.split('-') ?? [];
    const layer = entry.layer as { 'x-fixtureMetadata'?: Record<string, unknown> } | undefined;
    const tms = 2 ** tile.level - 1 - tile.y;
    const metadata = layer?.['x-fixtureMetadata']?.[`${tile.level}/${tile.x}/${tms}`];
    return {
      ...(names.includes('octvertexnormals') ? { normals: true } : {}),
      ...(names.includes('watermask') ? { waterMask: true } : {}),
      ...(names.includes('metadata') && metadata !== undefined ? { metadata } : {}),
    };
  }

  private async body(
    tile: FixtureTile,
    extension: string,
    rule: FaultRule | undefined,
    meshExtensions: QuantizedMeshExtensions = {},
  ): Promise<Buffer> {
    const variant = JSON.stringify(meshExtensions);
    const key = `${tile.pattern}/${tile.scheme}/${tile.level}/${tile.x}/${tile.y}.${extension}${variant}`;
    let body = this.cache.get(key);
    if (!body) {
      const encoding = TERRAIN[extension];
      body =
        (tile.pattern === ('terrain' as FixturePattern) || tile.pattern === ('terrain-geoid' as FixturePattern)) &&
        encoding
          ? terrainTile(tile, encoding, 256, 32, meshExtensions, tile.pattern === ('terrain-geoid' as FixturePattern))
          : extension === 'png'
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
    const origin = this.cors.has(res) ? this.cors.get(res) : '*';
    if (origin === undefined) res.removeHeader('Access-Control-Allow-Origin');
    res.writeHead(status, {
      ...headers,
      ...(origin === undefined
        ? {}
        : {
            'Access-Control-Allow-Origin': origin,
            ...(origin === '*' ? {} : { 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin' }),
          }),
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
