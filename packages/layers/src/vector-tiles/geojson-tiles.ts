/**
 * GeoJSON sources of a style (F444; ADR 0131): the data cut into the tiles a frame asks for and encoded as Mapbox
 * Vector Tiles (one layer, {@link GEOJSON_LAYER}, which style layers of a GeoJSON source read: they have no `source-layer`), so they take the same
 * path as downloaded tiles: the loader, the worker layout and the meshes. Coordinates are clipped to the tile and its
 * buffer; no simplification (inline style data is small).
 */
import { PbfWriter } from 'pbf';
import type { AbortHandle, TileRequest, TileTransport, TransportResult } from '@vibeglobe/core';
import { clipRing, signedArea, type TilePoint } from './fill-tessellate.js';
import { BUCKET_BUFFER, BUCKET_EXTENT, GEOJSON_LAYER } from './layout-tile.js';
import { clipLine } from './line-tessellate.js';

/** The URL scheme of GeoJSON source tiles: `geojson://<source>/{z}/{x}/{y}`. */
export const GEOJSON_SCHEME = 'geojson://';

type Position = readonly number[];
interface Geometry {
  readonly type: string;
  readonly coordinates?: unknown;
  readonly geometries?: readonly Geometry[];
}
interface Feature {
  readonly id?: unknown;
  readonly geometry: Geometry | null;
  readonly properties?: Record<string, unknown> | null;
}

/** Point (1), line (2) or polygon (3) parts of a feature in lon/lat, flattened from any GeoJSON geometry. */
interface Shape {
  readonly type: 1 | 2 | 3;
  readonly parts: readonly (readonly Position[])[];
  readonly properties: Record<string, unknown>;
  readonly id: number | undefined;
}

function shapesOf(geometry: Geometry | null, base: Omit<Shape, 'type' | 'parts'>, out: Shape[]): void {
  if (geometry === null) return;
  const c = geometry.coordinates as never;
  switch (geometry.type) {
    case 'Point':
      out.push({ ...base, type: 1, parts: [[c]] });
      break;
    case 'MultiPoint':
      out.push({ ...base, type: 1, parts: (c as Position[]).map((p) => [p]) });
      break;
    case 'LineString':
      out.push({ ...base, type: 2, parts: [c] });
      break;
    case 'MultiLineString':
      out.push({ ...base, type: 2, parts: c });
      break;
    case 'Polygon':
      out.push({ ...base, type: 3, parts: c });
      break;
    case 'MultiPolygon':
      for (const polygon of c as Position[][][]) out.push({ ...base, type: 3, parts: polygon });
      break;
    case 'GeometryCollection':
      for (const g of geometry.geometries ?? []) shapesOf(g, base, out);
      break;
    default:
  }
}

const isPosition = (p: unknown): boolean =>
  Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);

/** Whether every part is a list of positions. */
function wellFormed(shape: Shape): boolean {
  return Array.isArray(shape.parts) && shape.parts.every((part) => Array.isArray(part) && part.every(isPosition));
}

/** The features of any GeoJSON object (feature collection, feature or bare geometry); malformed input yields none. */
export function geojsonShapes(data: unknown): Shape[] {
  const out: Shape[] = [];
  const add = (f: Feature) => {
    const id = typeof f.id === 'number' && Number.isInteger(f.id) && f.id >= 0 ? f.id : undefined;
    const shapes: Shape[] = [];
    try {
      shapesOf(f.geometry, { properties: f.properties ?? {}, id }, shapes);
    } catch {
      // A feature with malformed coordinates is left out.
    }
    out.push(...shapes.filter(wellFormed));
  };
  const d = data as { type?: string; features?: Feature[] } | null;
  if (d === null || typeof d !== 'object') return out;
  if (d.type === 'FeatureCollection' && Array.isArray(d.features)) for (const f of d.features) add(f);
  else if (d.type === 'Feature') add(d as Feature);
  else add({ geometry: d as Geometry });
  return out;
}

/** A position in the tile's units (extent 4096). */
function toTile(z: number, x: number, y: number, p: Position): TilePoint {
  const lat = Math.max(-85.0511, Math.min(85.0511, Number(p[1])));
  const s = Math.sin((lat * Math.PI) / 180);
  const n = 2 ** z;
  const wx = (Number(p[0]) + 180) / 360;
  const wy = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  return [Math.round((wx * n - x) * BUCKET_EXTENT), Math.round((wy * n - y) * BUCKET_EXTENT)];
}

const RECT = {
  minX: -BUCKET_BUFFER,
  minY: -BUCKET_BUFFER,
  maxX: BUCKET_EXTENT + BUCKET_BUFFER,
  maxY: BUCKET_EXTENT + BUCKET_BUFFER,
};

/** A shape's parts clipped to the tile and its buffer, in tile units; polygons wound as MVT 2.1 asks. */
function clipped(shape: Shape, z: number, x: number, y: number): TilePoint[][] {
  const parts = shape.parts.map((part) => part.map((p) => toTile(z, x, y, p)));
  if (shape.type === 1)
    return parts.filter(
      ([p]) => p !== undefined && p[0] >= 0 && p[1] >= 0 && p[0] < BUCKET_EXTENT && p[1] < BUCKET_EXTENT,
    );
  if (shape.type === 2) return parts.flatMap((part) => clipLine(part, RECT)).filter((part) => part.length >= 2);
  const rings: TilePoint[][] = [];
  parts.forEach((ring, i) => {
    const r = clipRing(ring, RECT);
    if (r.length < 3 || Math.abs(signedArea(r)) <= 0.5) return;
    // Exteriors positive in tile space (clockwise on screen), holes negative.
    if (signedArea(r) > 0 !== (i === 0)) r.reverse();
    rings.push(r);
  });
  return rings;
}

const zigzag = (n: number) => (n << 1) ^ (n >> 31);

function commands(type: 1 | 2 | 3, parts: readonly TilePoint[][]): number[] {
  const out: number[] = [];
  let cx = 0;
  let cy = 0;
  const point = ([px, py]: TilePoint) => {
    out.push(zigzag(px - cx), zigzag(py - cy));
    cx = px;
    cy = py;
  };
  if (type === 1) {
    out.push((parts.length << 3) | 1);
    for (const [p] of parts) if (p !== undefined) point(p);
    return out;
  }
  for (const part of parts) {
    const [first, ...rest] = part;
    if (first === undefined) continue;
    out.push((1 << 3) | 1);
    point(first);
    out.push((rest.length << 3) | 2);
    for (const p of rest) point(p);
    if (type === 3) out.push((1 << 3) | 7);
  }
  return out;
}

/** The tile of a GeoJSON source as MVT bytes (one layer, {@link GEOJSON_LAYER}), or undefined when no feature reaches it. */
export function encodeGeoJsonTile(shapes: readonly Shape[], z: number, x: number, y: number): ArrayBuffer | undefined {
  const keys: string[] = [];
  const values: unknown[] = [];
  const index = <T>(list: T[], value: T) => {
    const i = list.indexOf(value);
    return i >= 0 ? i : list.push(value) - 1;
  };
  const features: { id: number | undefined; type: number; tags: number[]; geometry: number[] }[] = [];
  for (const shape of shapes) {
    const parts = clipped(shape, z, x, y);
    if (parts.length === 0) continue;
    const tags: number[] = [];
    for (const [k, v] of Object.entries(shape.properties)) {
      if (v === null || v === undefined) continue;
      const value = typeof v === 'object' ? JSON.stringify(v) : v;
      tags.push(index(keys, k), index(values, value));
    }
    features.push({ id: shape.id, type: shape.type, tags, geometry: commands(shape.type, parts) });
  }
  if (features.length === 0) return undefined;
  const pbf = new PbfWriter();
  pbf.writeMessage(
    3,
    (_: unknown, w: PbfWriter) => {
      w.writeVarintField(15, 2);
      w.writeStringField(1, GEOJSON_LAYER);
      for (const f of features)
        w.writeMessage(
          2,
          (__: unknown, fw: PbfWriter) => {
            if (f.id !== undefined) fw.writeVarintField(1, f.id);
            fw.writePackedVarint(2, f.tags);
            fw.writeVarintField(3, f.type);
            fw.writePackedVarint(4, f.geometry);
          },
          undefined,
        );
      for (const k of keys) w.writeStringField(3, k);
      for (const v of values)
        w.writeMessage(
          4,
          (__: unknown, vw: PbfWriter) => {
            if (typeof v === 'string') vw.writeStringField(1, v);
            else if (typeof v === 'boolean') vw.writeBooleanField(7, v);
            else if (Number.isInteger(v)) vw.writeSVarintField(6, v as number);
            else vw.writeDoubleField(3, Number(v));
          },
          undefined,
        );
      w.writeVarintField(5, BUCKET_EXTENT);
    },
    undefined,
  );
  const bytes = pbf.finish();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** A transport that answers `geojson://<source>/{z}/{x}/{y}` requests from the source's data. */
export function geojsonTransport(data: unknown): TileTransport {
  const shapes = geojsonShapes(data);
  return {
    start(request: TileRequest, _timeouts: unknown, done: (result: TransportResult) => void): AbortHandle {
      // Answered after `start` returns, as a network request is: the caller records the request first.
      let ended = false;
      queueMicrotask(() => {
        if (ended) return;
        ended = true;
        const [z = 0, x = 0, y = 0] = request.url.split('/').slice(-3).map(Number);
        const bytes = encodeGeoJsonTile(shapes, z, x, y);
        done(
          bytes === undefined
            ? { kind: 'status', status: 204, retryAfterMs: undefined }
            : { kind: 'ok', bytes, contentType: 'application/x-protobuf' },
        );
      });
      return () => {
        if (ended) return;
        ended = true;
        done({ kind: 'aborted' });
      };
    },
  };
}
