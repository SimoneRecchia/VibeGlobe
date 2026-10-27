/**
 * A small GLB writer for the generated 3D Tiles fixtures (F461–F467, F471): indexed triangle meshes with positions,
 * normals, optional texture coordinates and feature ids, plain or compressed with Draco (`KHR_draco_mesh_compression`)
 * or meshopt (`EXT_meshopt_compression`), and optional KTX2 textures (`KHR_texture_basisu`). Test code only.
 */
import { createRequire } from 'node:module';
import { MeshoptEncoder } from 'meshoptimizer';

/** One primitive to write. */
export interface PrimitiveData {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs?: Float32Array;
  /** One feature id per vertex. */
  readonly featureIds: Float32Array;
  readonly indices: Uint16Array;
  readonly color: readonly [number, number, number, number];
  /** Encoded image (PNG or KTX2) for the base color. */
  readonly image?: { readonly bytes: Uint8Array; readonly mimeType: 'image/png' | 'image/ktx2' };
}

/** How the GLB stores its geometry. */
export type Compression = 'none' | 'draco' | 'meshopt';

/** What to write. */
export interface GlbInput {
  readonly primitives: readonly PrimitiveData[];
  /** `_BATCHID` (3D Tiles 1.0 b3dm) or `_FEATURE_ID_0` with `EXT_mesh_features` (1.1). */
  readonly featureAttribute: '_BATCHID' | '_FEATURE_ID_0';
  readonly compression: Compression;
  readonly copyright?: string;
  /** `EXT_structural_metadata` (schema, one property table) for `_FEATURE_ID_0`; its buffer views come first. */
  readonly metadata?: { readonly schema: unknown; readonly table: (view: (bytes: Uint8Array) => number) => unknown };
}

interface DracoEncoderModule {
  Encoder: new () => {
    SetEncodingMethod(method: number): void;
    SetAttributeQuantization(attribute: number, bits: number): void;
    EncodeMeshToDracoBuffer(mesh: object, out: { GetValue(i: number): number }): number;
  };
  MeshBuilder: new () => {
    AddFacesToMesh(mesh: object, faces: number, indices: Uint32Array): void;
    AddFloatAttributeToMesh(mesh: object, type: number, points: number, components: number, data: Float32Array): number;
  };
  Mesh: new () => object;
  DracoInt8Array: new () => { GetValue(i: number): number };
  POSITION: number;
  NORMAL: number;
  TEX_COORD: number;
  GENERIC: number;
  MESH_SEQUENTIAL_ENCODING: number;
  destroy(object: object): void;
}

let draco: Promise<DracoEncoderModule> | undefined;
function dracoEncoder(): Promise<DracoEncoderModule> {
  const draco3d = createRequire(import.meta.url)('draco3d') as {
    createEncoderModule(options: object): Promise<DracoEncoderModule>;
  };
  draco ??= draco3d.createEncoderModule({});
  return draco;
}

async function dracoEncode(p: PrimitiveData): Promise<{ bytes: Uint8Array; ids: Record<string, number> }> {
  const m = await dracoEncoder();
  const builder = new m.MeshBuilder();
  const mesh = new m.Mesh();
  const points = p.positions.length / 3;
  builder.AddFacesToMesh(mesh, p.indices.length / 3, Uint32Array.from(p.indices));
  const ids: Record<string, number> = {
    POSITION: builder.AddFloatAttributeToMesh(mesh, m.POSITION, points, 3, p.positions),
    NORMAL: builder.AddFloatAttributeToMesh(mesh, m.NORMAL, points, 3, p.normals),
  };
  if (p.uvs) ids['TEXCOORD_0'] = builder.AddFloatAttributeToMesh(mesh, m.TEX_COORD, points, 2, p.uvs);
  ids['FEATURE'] = builder.AddFloatAttributeToMesh(mesh, m.GENERIC, points, 1, p.featureIds);
  const encoder = new m.Encoder();
  encoder.SetEncodingMethod(m.MESH_SEQUENTIAL_ENCODING);
  encoder.SetAttributeQuantization(m.POSITION, 16);
  const out = new m.DracoInt8Array();
  const length = encoder.EncodeMeshToDracoBuffer(mesh, out);
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = out.GetValue(i) & 0xff;
  for (const object of [mesh, builder, encoder, out]) m.destroy(object);
  return { bytes, ids };
}

const pad4 = (n: number): number => (n + 3) & ~3;
const bytesOf = (a: Float32Array | Uint16Array): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
const SIZES: Readonly<Record<string, readonly [string, number]>> = {
  POSITION: ['VEC3', 3],
  NORMAL: ['VEC3', 3],
  TEXCOORD_0: ['VEC2', 2],
};

type Json = Record<string, unknown>;

/** The GLB's JSON and binary chunk while it is written. */
class GlbBuilder {
  private readonly bin: Uint8Array[] = [];
  private binLength = 0;
  private fallbackLength = 0;
  readonly bufferViews: Json[] = [];
  readonly accessors: Json[] = [];
  readonly images: Json[] = [];
  readonly textures: Json[] = [];
  readonly materials: Json[] = [];
  readonly primitives: Json[] = [];
  readonly used = new Set<string>();

  private readonly input: GlbInput;

  constructor(input: GlbInput) {
    this.input = input;
  }

  private append(bytes: Uint8Array): number {
    const offset = this.binLength;
    this.bin.push(bytes, new Uint8Array(pad4(bytes.length) - bytes.length));
    this.binLength += pad4(bytes.length);
    return offset;
  }

  view(bytes: Uint8Array, extra: Json = {}): number {
    this.bufferViews.push({ buffer: 0, byteOffset: this.append(bytes), byteLength: bytes.length, ...extra });
    return this.bufferViews.length - 1;
  }

  private meshoptView(raw: Uint8Array, count: number, stride: number, mode: 'ATTRIBUTES' | 'TRIANGLES'): number {
    const compressed =
      mode === 'ATTRIBUTES'
        ? MeshoptEncoder.encodeVertexBuffer(raw, count, stride)
        : MeshoptEncoder.encodeIndexBuffer(raw, count, stride);
    const byteOffset = this.append(compressed);
    const extension = { buffer: 0, byteOffset, byteLength: compressed.length, byteStride: stride, count, mode };
    this.bufferViews.push({
      buffer: 1,
      byteOffset: this.fallbackLength,
      byteLength: raw.length,
      ...(mode === 'ATTRIBUTES' ? { byteStride: stride } : {}),
      extensions: { EXT_meshopt_compression: extension },
    });
    this.fallbackLength += pad4(raw.length);
    return this.bufferViews.length - 1;
  }

  private accessor(
    array: Float32Array | Uint16Array,
    type: string,
    size: number,
    viewIndex: number | undefined,
  ): number {
    const out: Json = { componentType: array instanceof Uint16Array ? 5123 : 5126, count: array.length / size, type };
    if (viewIndex !== undefined) out['bufferView'] = viewIndex;
    if (type === 'VEC3') {
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      array.forEach((v, i) => {
        min[i % 3] = Math.min(min[i % 3] ?? 0, v);
        max[i % 3] = Math.max(max[i % 3] ?? 0, v);
      });
      Object.assign(out, { min, max });
    }
    this.accessors.push(out);
    return this.accessors.length - 1;
  }

  private attributesOf(p: PrimitiveData): Record<string, Float32Array> {
    const attributes: Record<string, Float32Array> = { POSITION: p.positions, NORMAL: p.normals };
    if (p.uvs) attributes['TEXCOORD_0'] = p.uvs;
    attributes[this.input.featureAttribute] = p.featureIds;
    return attributes;
  }

  private async dracoPrimitive(p: PrimitiveData, primitive: Json): Promise<void> {
    this.used.add('KHR_draco_mesh_compression');
    const encoded = await dracoEncode(p);
    const indexed: Record<string, number> = {};
    const dracoAttributes: Record<string, number> = {};
    for (const [name, array] of Object.entries(this.attributesOf(p))) {
      const [type, size] = SIZES[name] ?? ['SCALAR', 1];
      indexed[name] = this.accessor(array, type, size, undefined);
      dracoAttributes[name] = encoded.ids[name === this.input.featureAttribute ? 'FEATURE' : name] ?? 0;
    }
    primitive['attributes'] = indexed;
    primitive['indices'] = this.accessor(p.indices, 'SCALAR', 1, undefined);
    primitive['extensions'] = {
      KHR_draco_mesh_compression: { bufferView: this.view(encoded.bytes), attributes: dracoAttributes },
    };
  }

  private plainPrimitive(p: PrimitiveData, primitive: Json): void {
    const meshopt = this.input.compression === 'meshopt';
    if (meshopt) this.used.add('EXT_meshopt_compression');
    const indexed: Record<string, number> = {};
    for (const [name, a] of Object.entries(this.attributesOf(p))) {
      const [type, size] = SIZES[name] ?? ['SCALAR', 1];
      const v = meshopt
        ? this.meshoptView(bytesOf(a), a.length / size, size * 4, 'ATTRIBUTES')
        : this.view(bytesOf(a), { byteStride: size * 4, target: 34962 });
      indexed[name] = this.accessor(a, type, size, v);
    }
    primitive['attributes'] = indexed;
    const iv = meshopt
      ? this.meshoptView(bytesOf(p.indices), p.indices.length, 2, 'TRIANGLES')
      : this.view(bytesOf(p.indices), { target: 34963 });
    primitive['indices'] = this.accessor(p.indices, 'SCALAR', 1, iv);
  }

  private material(p: PrimitiveData): number {
    const pbr: Json = { baseColorFactor: p.color, metallicFactor: 0 };
    if (p.image) {
      this.images.push({ bufferView: this.view(p.image.bytes), mimeType: p.image.mimeType });
      const ktx2 = p.image.mimeType === 'image/ktx2';
      if (ktx2) this.used.add('KHR_texture_basisu');
      const source = this.images.length - 1;
      this.textures.push(ktx2 ? { extensions: { KHR_texture_basisu: { source } } } : { source });
      pbr['baseColorTexture'] = { index: this.textures.length - 1 };
    }
    this.materials.push({ pbrMetallicRoughness: pbr });
    return this.materials.length - 1;
  }

  async add(p: PrimitiveData, withTable: boolean): Promise<void> {
    const primitive: Json = { mode: 4 };
    if (this.input.compression === 'draco') await this.dracoPrimitive(p, primitive);
    else this.plainPrimitive(p, primitive);
    primitive['material'] = this.material(p);
    if (this.input.featureAttribute === '_FEATURE_ID_0') {
      this.used.add('EXT_mesh_features');
      const featureIds = [
        { featureCount: new Set(p.featureIds).size, attribute: 0, ...(withTable ? { propertyTable: 0 } : {}) },
      ];
      primitive['extensions'] = { ...(primitive['extensions'] as Json | undefined), EXT_mesh_features: { featureIds } };
    }
    this.primitives.push(primitive);
  }

  json(metadata: { schema: unknown; table: unknown } | undefined): Json {
    if (metadata) this.used.add('EXT_structural_metadata');
    const required = [...this.used].filter((e) => e !== 'EXT_mesh_features' && e !== 'EXT_structural_metadata');
    const buffers: Json[] = [{ byteLength: this.binLength }];
    if (this.fallbackLength > 0)
      buffers.push({ byteLength: this.fallbackLength, extensions: { EXT_meshopt_compression: { fallback: true } } });
    const copyright = this.input.copyright;
    return {
      asset: { version: '2.0', generator: 'VibeGlobe fixture city', ...(copyright ? { copyright } : {}) },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: this.primitives }],
      materials: this.materials,
      ...(this.images.length > 0 ? { images: this.images, textures: this.textures } : {}),
      accessors: this.accessors,
      bufferViews: this.bufferViews,
      buffers,
      ...(this.used.size > 0 ? { extensionsUsed: [...this.used] } : {}),
      ...(required.length > 0 ? { extensionsRequired: required } : {}),
      ...(metadata
        ? { extensions: { EXT_structural_metadata: { schema: metadata.schema, propertyTables: [metadata.table] } } }
        : {}),
    };
  }

  glb(json: Json): Uint8Array {
    const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    const jsonLength = pad4(jsonBytes.length);
    const total = 28 + jsonLength + this.binLength;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true);
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jsonLength, true);
    dv.setUint32(16, 0x4e4f534a, true);
    out.fill(0x20, 20, 20 + jsonLength);
    out.set(jsonBytes, 20);
    dv.setUint32(20 + jsonLength, this.binLength, true);
    dv.setUint32(24 + jsonLength, 0x004e4942, true);
    let offset = 28 + jsonLength;
    for (const chunk of this.bin) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

/** Writes a GLB. */
export async function writeGlb(input: GlbInput): Promise<Uint8Array> {
  await MeshoptEncoder.ready;
  const builder = new GlbBuilder(input);
  const metadata = input.metadata
    ? { schema: input.metadata.schema, table: input.metadata.table((bytes) => builder.view(bytes)) }
    : undefined;
  for (const p of input.primitives) await builder.add(p, metadata !== undefined);
  return builder.glb(builder.json(metadata));
}
