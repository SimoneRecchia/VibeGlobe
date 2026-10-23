import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeQuantizedMesh, rasterizeQuantizedMesh } from './quantized-mesh.js';

interface TileSpec {
  minHeight: number;
  maxHeight: number;
  /** Quantized u, v, height (0–32767) per vertex. */
  vertices: [number, number, number][];
  triangles: [number, number, number][];
  extensions?: { id: number; body: Uint8Array }[];
  /** Extra vertices appended (not referenced) to force 32-bit indices. */
  padVertices?: number;
}

/** Encodes a quantized-mesh-1.0 tile, as a terrain server would (the format's specification, written here). */
function encode(spec: TileSpec): Uint8Array {
  const vertices = [...spec.vertices, ...Array.from({ length: spec.padVertices ?? 0 }, () => [0, 0, 0] as const)];
  const n = vertices.length;
  const wide = n > 65536;
  const parts: number[] = [];
  const buffer = new ArrayBuffer(16 * 1024 * 1024);
  const view = new DataView(buffer);
  let o = 0;
  const f64 = (x: number): void => {
    view.setFloat64(o, x, true);
    o += 8;
  };
  for (let i = 0; i < 3; i++) f64(0);
  view.setFloat32(o, spec.minHeight, true);
  view.setFloat32(o + 4, spec.maxHeight, true);
  o += 8;
  for (let i = 0; i < 7; i++) f64(0);
  view.setUint32(o, n, true);
  o += 4;
  for (const axis of [0, 1, 2]) {
    let previous = 0;
    for (const vertex of vertices) {
      const delta = (vertex[axis] ?? 0) - previous;
      previous = vertex[axis] ?? 0;
      view.setUint16(o, (delta << 1) ^ (delta >> 31), true);
      o += 2;
    }
  }
  const index = (value: number): void => {
    if (wide) view.setUint32(o, value, true);
    else view.setUint16(o, value, true);
    o += wide ? 4 : 2;
  };
  if (wide) o += (4 - (o % 4)) % 4;
  view.setUint32(o, spec.triangles.length, true);
  o += 4;
  let highest = 0;
  for (const triangle of spec.triangles)
    for (const vertex of triangle) {
      index(highest - vertex);
      if (vertex === highest) highest++;
    }
  // Edges: every vertex on the tile's border, by side.
  const side = (test: (v: readonly number[]) => boolean): void => {
    const list = spec.vertices.map((v, i) => [v, i] as const).filter(([v]) => test(v));
    view.setUint32(o, list.length, true);
    o += 4;
    for (const [, i] of list) index(i);
  };
  side((v) => v[0] === 0);
  side((v) => v[1] === 0);
  side((v) => v[0] === 32767);
  side((v) => v[1] === 32767);
  for (const extension of spec.extensions ?? []) {
    view.setUint8(o, extension.id);
    view.setUint32(o + 1, extension.body.length, true);
    new Uint8Array(buffer).set(extension.body, o + 5);
    o += 5 + extension.body.length;
  }
  parts.push(o);
  return new Uint8Array(buffer, 0, o).slice();
}

/** A square of two triangles: heights 0 (south-west), 100 (south-east), 200 (north-east), 100 (north-west). */
const SQUARE: TileSpec = {
  minHeight: 0,
  maxHeight: 200,
  vertices: [
    [0, 0, 0],
    [32767, 0, 16384],
    [32767, 32767, 32767],
    [0, 32767, 16384],
  ],
  triangles: [
    [0, 1, 2],
    [0, 2, 3],
  ],
};

describe('quantized-mesh', () => {
  it('decodes the header, zig-zag deltas, 16-bit high-water-mark indices and edges (F127)', () => {
    const mesh = decodeQuantizedMesh(encode(SQUARE));
    expect(mesh.minHeightMeters).toBe(0);
    expect(mesh.maxHeightMeters).toBe(200);
    expect([...mesh.u]).toEqual([0, 1, 1, 0]);
    expect([...mesh.v]).toEqual([0, 0, 1, 1]);
    expect(mesh.heightsMeters[2]).toBe(200);
    expect([...mesh.indices]).toEqual([0, 1, 2, 0, 2, 3]);
    expect([...mesh.west]).toEqual([0, 3]);
    expect([...mesh.east]).toEqual([1, 2]);
    expect(mesh.extensions).toEqual([]);
  });

  it('decodes oct-encoded normals, the water mask and metadata, and skips unknown extensions (F127, F128)', () => {
    // Oct encoding: (128, 128) is about +z, (255, 128) folds to about +x; two vertices up, two east.
    const normals = Uint8Array.of(128, 128, 128, 128, 255, 128, 255, 128);
    const json = new TextEncoder().encode(
      JSON.stringify({ available: [[{ startX: 0, startY: 0, endX: 1, endY: 1 }]] }),
    );
    const metadata = new Uint8Array(4 + json.length);
    new DataView(metadata.buffer).setUint32(0, json.length, true);
    metadata.set(json, 4);
    const mesh = decodeQuantizedMesh(
      encode({
        ...SQUARE,
        extensions: [
          { id: 1, body: normals },
          { id: 2, body: Uint8Array.of(255) },
          { id: 7, body: Uint8Array.of(1, 2, 3) },
          { id: 4, body: metadata },
        ],
      }),
    );
    expect(mesh.extensions).toEqual([1, 2, 7, 4]);
    expect(mesh.normals?.[2]).toBeCloseTo(1, 2);
    expect(mesh.normals?.[6]).toBeCloseTo(1, 2);
    for (let i = 0; i < 4; i++) {
      const n = mesh.normals?.subarray(i * 3, i * 3 + 3) ?? new Float32Array(3);
      expect(Math.hypot(n[0] ?? 0, n[1] ?? 0, n[2] ?? 0)).toBeCloseTo(1, 5);
    }
    expect(mesh.waterMask).toBe(255);
    expect(mesh.metadata).toEqual({ available: [[{ startX: 0, startY: 0, endX: 1, endY: 1 }]] });
    // A 256 × 256 water mask, and normals that do not match the vertices.
    const mask = new Uint8Array(256 * 256).fill(9);
    expect(decodeQuantizedMesh(encode({ ...SQUARE, extensions: [{ id: 2, body: mask }] })).waterMask).toEqual(mask);
    expect(() =>
      decodeQuantizedMesh(encode({ ...SQUARE, extensions: [{ id: 1, body: Uint8Array.of(1, 2) }] })),
    ).toThrow(RangeError);
  });

  it('reads 32-bit indices when a tile has more than 65,536 vertices (F127)', () => {
    const mesh = decodeQuantizedMesh(encode({ ...SQUARE, padVertices: 65536 }));
    expect(mesh.u.length).toBe(65540);
    expect([...mesh.indices]).toEqual([0, 1, 2, 0, 2, 3]);
    // The edge lists are 32-bit too: west, south, east, north.
    expect([[...mesh.west], [...mesh.south], [...mesh.east], [...mesh.north]]).toEqual([
      [0, 3],
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
  });

  it('decodes a stored .terrain fixture to its stored reference values (F127)', () => {
    const name = 'fixtures/geographic-8-266-62';
    const bytes = new Uint8Array(readFileSync(new URL(`./${name}.terrain`, import.meta.url)));
    const reference = JSON.parse(readFileSync(new URL(`./${name}.json`, import.meta.url), 'utf8')) as {
      minHeightMeters: number;
      maxHeightMeters: number;
      vertexCount: number;
      triangleCount: number;
      edgeVertices: number;
      quantizationMeters: number;
      metadataAvailable: unknown;
      samples: { u: number; v: number; heightMeters: number }[];
    };
    const mesh = decodeQuantizedMesh(bytes);
    expect(mesh.minHeightMeters).toBe(reference.minHeightMeters);
    expect(mesh.maxHeightMeters).toBe(reference.maxHeightMeters);
    expect(mesh.u.length).toBe(reference.vertexCount);
    expect(mesh.indices.length / 3).toBe(reference.triangleCount);
    for (const edge of [mesh.west, mesh.south, mesh.east, mesh.north]) expect(edge.length).toBe(reference.edgeVertices);
    expect((mesh.metadata as { available?: unknown }).available).toEqual(reference.metadataAvailable);
    // Each sample's vertex carries the analytic terrain height, within one quantization step.
    for (const sample of reference.samples) {
      let found = -1;
      for (let i = 0; i < mesh.u.length; i++)
        if (Math.abs((mesh.u[i] ?? 0) - sample.u) < 1e-4 && Math.abs((mesh.v[i] ?? 0) - sample.v) < 1e-4) found = i;
      expect(found).toBeGreaterThanOrEqual(0);
      expect(Math.abs((mesh.heightsMeters[found] ?? 0) - sample.heightMeters)).toBeLessThanOrEqual(
        reference.quantizationMeters,
      );
    }
  });

  it('rasterizes to the height grid with the barycentric heights of its triangles', () => {
    const grid = rasterizeQuantizedMesh(decodeQuantizedMesh(encode(SQUARE)), 2);
    // Row 0 is the north edge: 100, 150, 200; the center lies on the shared diagonal: 100.
    const h = [...grid.heightsMeters].map((x) => Math.round(x));
    expect(h.slice(0, 3)).toEqual([100, 150, 200]);
    expect(h[4]).toBe(100);
    expect(h.slice(6, 9)).toEqual([0, 50, 100]);
    expect(grid.minMeters).toBe(0);
    expect(grid.maxMeters).toBeCloseTo(200, 3);
  });

  it('throws a RangeError on truncated or out-of-range bytes instead of reading past them (F131)', () => {
    const bytes = encode(SQUARE);
    for (const cut of [10, 88, 95, bytes.length - 3])
      expect(() => decodeQuantizedMesh(bytes.slice(0, cut))).toThrow(RangeError);
    const bad = bytes.slice();
    // The first triangle index jumps past the vertices.
    new DataView(bad.buffer).setUint16(88 + 4 + 4 * 6 + 4, 7, true);
    expect(() => decodeQuantizedMesh(bad)).toThrow(RangeError);
  });
});
