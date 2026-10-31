// Writes small glTF 2.0 binaries (.glb) and the PNG textures they embed, for the playground's generated models.
import { deflateSync } from 'node:zlib';

/** A triangle mesh under construction: positions, normals and texture coordinates per vertex. */
export class MeshBuilder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly uvs: number[] = [];
  readonly indices: number[] = [];

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  vertex(p: Vec3, n: Vec3, u: number, v: number): number {
    this.positions.push(p[0], p[1], p[2]);
    const length = Math.hypot(n[0], n[1], n[2]) || 1;
    this.normals.push(n[0] / length, n[1] / length, n[2] / length);
    this.uvs.push(u, v);
    return this.vertexCount - 1;
  }

  triangle(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  /** Two triangles over a quad given counter-clockwise seen from its front. */
  quad(a: number, b: number, c: number, d: number): void {
    this.indices.push(a, b, c, a, c, d);
  }

  /** A flat quad with its own vertices, corners counter-clockwise seen from the front, UVs per corner. */
  flatQuad(corners: readonly [Vec3, Vec3, Vec3, Vec3], uvs: readonly [number, number][]): void {
    const n = cross(sub(corners[1], corners[0]), sub(corners[2], corners[0]));
    const first = this.vertexCount;
    corners.forEach((corner, i) => this.vertex(corner, n, uvs[i]?.[0] ?? 0, uvs[i]?.[1] ?? 0));
    this.quad(first, first + 1, first + 2, first + 3);
  }

  /** Recomputes smooth normals from the faces for the vertices from `first` on (vertices shared by faces). */
  smoothNormals(first: number): void {
    const sums = new Float64Array((this.vertexCount - first) * 3);
    for (let i = 0; i < this.indices.length; i += 3) {
      const [a, b, c] = [this.indices[i] ?? 0, this.indices[i + 1] ?? 0, this.indices[i + 2] ?? 0];
      if (a < first || b < first || c < first) continue;
      const n = cross(sub(this.point(b), this.point(a)), sub(this.point(c), this.point(a)));
      for (const k of [a, b, c])
        for (let j = 0; j < 3; j++) sums[(k - first) * 3 + j] = (sums[(k - first) * 3 + j] ?? 0) + (n[j] ?? 0);
    }
    for (let k = first; k < this.vertexCount; k++) {
      const s: Vec3 = [sums[(k - first) * 3] ?? 0, sums[(k - first) * 3 + 1] ?? 0, sums[(k - first) * 3 + 2] ?? 0];
      const length = Math.hypot(...s) || 1;
      for (let j = 0; j < 3; j++) this.normals[k * 3 + j] = (s[j] ?? 0) / length;
    }
  }

  point(index: number): Vec3 {
    return [this.positions[index * 3] ?? 0, this.positions[index * 3 + 1] ?? 0, this.positions[index * 3 + 2] ?? 0];
  }

  get triangleCount(): number {
    return this.indices.length / 3;
  }
}

export type Vec3 = [number, number, number];

export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** A material: a base color factor and an optional embedded PNG, repeated or clamped. */
interface MaterialSpec {
  readonly name: string;
  readonly png?: Uint8Array;
  readonly repeat?: boolean;
  readonly color?: readonly [number, number, number, number];
  readonly metallic?: number;
  readonly roughness?: number;
}

/** A node of the scene: a mesh with its material, a translation and rotation (quaternion), and children. */
export interface NodeSpec {
  readonly name: string;
  readonly mesh?: MeshBuilder;
  readonly material?: MaterialSpec;
  readonly translation?: Vec3;
  readonly rotation?: readonly [number, number, number, number];
  readonly children?: readonly NodeSpec[];
}

/** Encodes a scene of nodes as a .glb: one buffer, float32 attributes, 16-bit indices, embedded PNG textures. */
export function writeGlb(generator: string, roots: readonly NodeSpec[]): Uint8Array {
  const writer = new GlbWriter();
  const scene = roots.map((root) => writer.node(root));
  return writer.encode(generator, scene);
}

type Json = Record<string, unknown>;

class GlbWriter {
  private readonly chunks: Uint8Array[] = [];
  private byteLength = 0;
  private readonly bufferViews: Json[] = [];
  private readonly accessors: Json[] = [];
  private readonly meshes: Json[] = [];
  private readonly materials: Json[] = [];
  private readonly textures: Json[] = [];
  private readonly images: Json[] = [];
  private readonly samplers: Json[] = [];
  private readonly nodes: Json[] = [];
  private readonly materialIndex = new Map<MaterialSpec, number>();

  node(spec: NodeSpec): number {
    const entry: Json = { name: spec.name };
    this.nodes.push(entry);
    const index = this.nodes.length - 1;
    if (spec.translation) entry['translation'] = spec.translation.map(fround);
    if (spec.rotation) entry['rotation'] = spec.rotation.map(fround);
    if (spec.mesh) entry['mesh'] = this.mesh(spec.name, spec.mesh, spec.material);
    if (spec.children?.length) entry['children'] = spec.children.map((child) => this.node(child));
    return index;
  }

  encode(generator: string, scene: number[]): Uint8Array {
    const json: Json = {
      asset: { version: '2.0', generator },
      scene: 0,
      scenes: [{ nodes: scene }],
      nodes: this.nodes,
      meshes: this.meshes,
      materials: this.materials,
      accessors: this.accessors,
      bufferViews: this.bufferViews,
      buffers: [{ byteLength: this.byteLength }],
    };
    if (this.textures.length > 0)
      Object.assign(json, { textures: this.textures, images: this.images, samplers: this.samplers });
    const jsonBytes = pad(new TextEncoder().encode(JSON.stringify(json)), 0x20);
    const bin = pad(concat(this.chunks, this.byteLength), 0);
    const total = 12 + 8 + jsonBytes.byteLength + 8 + bin.byteLength;
    const out = new Uint8Array(total);
    const data = new DataView(out.buffer);
    data.setUint32(0, 0x46546c67, true);
    data.setUint32(4, 2, true);
    data.setUint32(8, total, true);
    data.setUint32(12, jsonBytes.byteLength, true);
    data.setUint32(16, 0x4e4f534a, true);
    out.set(jsonBytes, 20);
    const binAt = 20 + jsonBytes.byteLength;
    data.setUint32(binAt, bin.byteLength, true);
    data.setUint32(binAt + 4, 0x004e4942, true);
    out.set(bin, binAt + 8);
    return out;
  }

  private mesh(name: string, m: MeshBuilder, material: MaterialSpec | undefined): number {
    if (m.vertexCount > 65535) throw new Error(`${name}: too many vertices for 16-bit indices`);
    const attributes = {
      POSITION: this.accessor(m.positions, 'VEC3', true),
      NORMAL: this.accessor(m.normals, 'VEC3'),
      TEXCOORD_0: this.accessor(m.uvs, 'VEC2'),
    };
    const indices = this.accessor(m.indices, 'SCALAR');
    const primitive = { attributes, indices, ...(material ? { material: this.material(material) } : {}) };
    this.meshes.push({ name, primitives: [primitive] });
    return this.meshes.length - 1;
  }

  private view(bytes: Uint8Array, target?: number): number {
    const padding = (4 - (this.byteLength % 4)) % 4;
    if (padding > 0) this.chunks.push(new Uint8Array(padding));
    this.byteLength += padding;
    this.bufferViews.push({
      buffer: 0,
      byteOffset: this.byteLength,
      byteLength: bytes.byteLength,
      ...(target ? { target } : {}),
    });
    this.chunks.push(bytes);
    this.byteLength += bytes.byteLength;
    return this.bufferViews.length - 1;
  }

  private accessor(values: number[], type: 'VEC3' | 'VEC2' | 'SCALAR', bounds = false): number {
    const isIndex = type === 'SCALAR';
    const array = isIndex ? new Uint16Array(values) : new Float32Array(values);
    const width = type === 'VEC3' ? 3 : type === 'VEC2' ? 2 : 1;
    const entry: Json = {
      bufferView: this.view(new Uint8Array(array.buffer), isIndex ? 34963 : 34962),
      componentType: isIndex ? 5123 : 5126,
      count: values.length / width,
      type,
    };
    if (bounds) {
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      values.forEach((value, i) => {
        min[i % 3] = Math.min(min[i % 3] ?? 0, value);
        max[i % 3] = Math.max(max[i % 3] ?? 0, value);
      });
      Object.assign(entry, { min: min.map(fround), max: max.map(fround) });
    }
    this.accessors.push(entry);
    return this.accessors.length - 1;
  }

  private material(spec: MaterialSpec): number {
    const known = this.materialIndex.get(spec);
    if (known !== undefined) return known;
    const pbr: Json = {
      baseColorFactor: spec.color ?? [1, 1, 1, 1],
      metallicFactor: spec.metallic ?? 0,
      roughnessFactor: spec.roughness ?? 0.8,
    };
    if (spec.png) {
      this.images.push({ bufferView: this.view(spec.png), mimeType: 'image/png' });
      const wrap = spec.repeat ? 10497 : 33071;
      this.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: wrap, wrapT: wrap });
      this.textures.push({ source: this.images.length - 1, sampler: this.samplers.length - 1 });
      pbr['baseColorTexture'] = { index: this.textures.length - 1 };
    }
    this.materials.push({ name: spec.name, pbrMetallicRoughness: pbr });
    this.materialIndex.set(spec, this.materials.length - 1);
    return this.materials.length - 1;
  }
}

const fround = (value: number): number => Math.fround(value);

function concat(chunks: readonly Uint8Array[], byteLength: number): Uint8Array {
  const out = new Uint8Array(byteLength);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

function pad(bytes: Uint8Array, fill: number): Uint8Array {
  const padding = (4 - (bytes.byteLength % 4)) % 4;
  if (padding === 0) return bytes;
  const out = new Uint8Array(bytes.byteLength + padding).fill(fill);
  out.set(bytes);
  return out;
}

/** An RGBA image drawn pixel by pixel, encoded as PNG. */
export class Image {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
  }

  /** Sets every pixel from a function of its center in [0, 1]², sampled 4 × 4 times and averaged (antialiased). */
  paint(color: (u: number, v: number) => readonly [number, number, number]): void {
    for (let y = 0; y < this.height; y++)
      for (let x = 0; x < this.width; x++) {
        const sum = [0, 0, 0];
        for (let sy = 0; sy < 4; sy++)
          for (let sx = 0; sx < 4; sx++) {
            const c = color((x + (sx + 0.5) / 4) / this.width, (y + (sy + 0.5) / 4) / this.height);
            for (let k = 0; k < 3; k++) sum[k] = (sum[k] ?? 0) + (c[k] ?? 0);
          }
        const at = (y * this.width + x) * 4;
        for (let k = 0; k < 3; k++) this.data[at + k] = Math.round(Math.min(255, Math.max(0, (sum[k] ?? 0) / 16)));
        this.data[at + 3] = 255;
      }
  }

  /** PNG bytes (8-bit RGBA, no interlace), top row first: `paint`'s v = 0 is the top row, as glTF's texture coordinates. */
  png(): Uint8Array {
    const raw = new Uint8Array((this.width * 4 + 1) * this.height);
    for (let y = 0; y < this.height; y++) {
      // Filter "up" for rows after the first: smooth images compress better.
      const row = y * (this.width * 4 + 1);
      raw[row] = y === 0 ? 0 : 2;
      for (let i = 0; i < this.width * 4; i++) {
        const value = this.data[y * this.width * 4 + i] ?? 0;
        const above = y === 0 ? 0 : (this.data[(y - 1) * this.width * 4 + i] ?? 0);
        raw[row + 1 + i] = (value - above) & 0xff;
      }
    }
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, this.width);
    view.setUint32(4, this.height);
    header.set([8, 6, 0, 0, 0], 8);
    return concatAll([
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', new Uint8Array(0)),
    ]);
  }
}

function concatAll(parts: readonly Uint8Array[]): Uint8Array {
  return concat(
    parts,
    parts.reduce((sum, part) => sum + part.byteLength, 0),
  );
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.byteLength);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < 8 + data.byteLength; i++) crc = (CRC_TABLE[(crc ^ (out[i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  view.setUint32(8 + data.byteLength, (crc ^ 0xffffffff) >>> 0);
  return out;
}
