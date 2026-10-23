// The glTF conformance suite (F361): the Khronos sample models in every committed variant, read by parseModel.
import { describe, expect, it } from 'vitest';
import { componentValue } from './accessors.js';
import { allSamples, sample } from './__fixtures__/khronos.js';
import {
  loadDraco3d,
  nodeMatrix,
  parseModel,
  readDocument,
  type ModelDescription,
  type ModelPrimitive,
} from './index.js';

const draco = loadDraco3d();

async function load(model: string, variant: string): Promise<ModelDescription> {
  const { bytes, resources } = sample(model, variant);
  return parseModel(bytes, { resources, draco });
}

/** Expected counters of each sample: meshes, instances, vertices and triangles over every instance. */
const EXPECTED: Readonly<Record<string, readonly [number, number, number, number]>> = {
  Box: [1, 1, 24, 12],
  BoxInterleaved: [1, 1, 24, 12],
  BoxVertexColors: [1, 1, 24, 12],
  MeshPrimitiveModes: [7, 7, 49, 16],
  MeshoptCubeTest: [35, 35, 640, 320],
  OrientationTest: [13, 13, 1048, 524],
  SimpleMeshes: [1, 2, 6, 2],
  SimpleSparseAccessor: [1, 1, 14, 12],
  TextureCoordinateTest: [5, 5, 20, 10],
  Triangle: [1, 1, 3, 1],
  TriangleWithoutIndices: [1, 1, 3, 1],
};

/** Every vertex position of a primitive, as numbers. */
function positions(p: ModelPrimitive): number[][] {
  const { array, normalized } = p.attributes['POSITION'] ?? { array: new Float32Array(), normalized: false };
  const result: number[][] = [];
  for (let i = 0; i < array.length; i += 3)
    result.push([0, 1, 2].map((c) => componentValue(array[i + c] ?? 0, array, normalized)));
  return result;
}

/** Each triangle as its three corner positions, sorted, so meshes compare whatever their vertex order. */
function triangleSet(p: ModelPrimitive, digits: number): string[] {
  const points = positions(p);
  const indices = p.indices ?? points.map((_, i) => i);
  const result: string[] = [];
  for (let i = 0; i + 2 < indices.length; i += 3)
    result.push(
      [0, 1, 2]
        .map((k) => (points[indices[i + k] ?? 0] ?? []).map((v) => v.toFixed(digits)).join(','))
        .sort()
        .join('|'),
    );
  return result.sort();
}

describe('Khronos sample models', () => {
  it.each(allSamples())(
    '$model ($variant) parses with the expected meshes, instances and counts',
    async ({ model, variant }) => {
      const description = await load(model, variant);
      const [meshes, instances, vertices, triangles] = EXPECTED[model] ?? [];
      expect([description.meshes.length, description.instances.length]).toEqual([meshes, instances]);
      expect(description.stats).toMatchObject({ vertices, triangles });
      // The positions decoded agree with the bounds the file declares (Draco within its quantization).
      const { doc } = readDocument(sample(model, variant).bytes);
      doc.meshes.forEach((mesh, i) =>
        mesh.primitives.forEach((p, j) => {
          const accessor = doc.accessors[p.attributes['POSITION'] ?? -1];
          const decoded = description.meshes[i]?.primitives[j];
          if (!accessor?.min || !accessor.max || !decoded) return;
          for (let c = 0; c < 3; c++) {
            expect(decoded.min[c]).toBeCloseTo(accessor.min[c] ?? 0, 3);
            expect(decoded.max[c]).toBeCloseTo(accessor.max[c] ?? 0, 3);
          }
        }),
      );
    },
  );

  it('reads the same box from .gltf with a .bin, .glb, embedded data URIs, interleaved buffers and Draco', async () => {
    const reference = triangleSet((await load('Box', 'glTF')).meshes[0]?.primitives[0] as ModelPrimitive, 4);
    for (const [model, variant] of [
      ['Box', 'glTF-Binary'],
      ['Box', 'glTF-Embedded'],
      ['BoxInterleaved', 'glTF-Binary'],
      ['Box', 'glTF-Draco'],
    ] as const)
      expect(triangleSet((await load(model, variant)).meshes[0]?.primitives[0] as ModelPrimitive, 2)).toEqual(
        reference.map((t) => t.replace(/-?\d+\.\d+/g, (v) => Number(v).toFixed(2))).sort(),
      );
  });

  it('decodes meshopt-compressed buffers to exactly the uncompressed data', async () => {
    const plain = await load('MeshoptCubeTest', 'glTF');
    const packed = await load('MeshoptCubeTest', 'glTF-Meshopt');
    expect(packed.extensionsUsed).toContain('KHR_meshopt_compression');
    packed.meshes.forEach((mesh, i) =>
      mesh.primitives.forEach((p, j) => {
        const other = plain.meshes[i]?.primitives[j];
        expect(p.indices).toEqual(other?.indices);
        for (const [semantic, attribute] of Object.entries(p.attributes))
          expect(attribute.array).toEqual(other?.attributes[semantic]?.array);
      }),
    );
  });

  it('applies sparse accessors over their base values', async () => {
    const model = await load('SimpleSparseAccessor', 'glTF');
    const points = positions(model.meshes[0]?.primitives[0] as ModelPrimitive);
    // The sparse substitution moves vertices 8, 10 and 12 to (1, 2), (3, 3) and (5, 4).
    expect([8, 10, 12].map((i) => points[i]?.slice(0, 2))).toEqual([
      [1, 2],
      [3, 3],
      [5, 4],
    ]);
  });

  it('keeps every primitive mode, vertex colors, materials and textures', async () => {
    const modes = (await load('MeshPrimitiveModes', 'glTF')).meshes.map((m) => m.primitives[0]?.mode).sort();
    expect(modes).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const colored = await load('BoxVertexColors', 'glTF-Binary');
    expect(colored.meshes[0]?.primitives[0]?.attributes['COLOR_0']?.itemSize).toBeGreaterThanOrEqual(3);
    const textured = await load('TextureCoordinateTest', 'glTF-Binary');
    expect(textured.images.map((i) => i.mimeType)).toEqual(['image/png']);
    const material = textured.materials.find((m) => m.baseColorTexture);
    expect(material?.baseColorTexture).toMatchObject({ image: 0, texCoord: 0 });
    expect(textured.meshes[0]?.primitives[0]?.attributes['TEXCOORD_0']?.itemSize).toBe(2);
  });

  it('places each node with its transform composed from the root', async () => {
    const { doc } = readDocument(sample('OrientationTest', 'glTF-Binary').bytes);
    const model = await load('OrientationTest', 'glTF-Binary');
    for (const instance of model.instances) {
      const node = doc.nodes[instance.node];
      if (!node) throw new Error(`node ${instance.node} missing`);
      // The sample's nodes are roots: each instance's matrix is its own local transform.
      expect([...instance.matrix].map((v) => v.toFixed(6))).toEqual([...nodeMatrix(node)].map((v) => v.toFixed(6)));
    }
    const meshes = await load('SimpleMeshes', 'glTF');
    expect(meshes.instances.map((i) => i.matrix[12])).toEqual([0, 1]);
    expect(meshes.max[0]).toBe(2);
  });
});

describe('KTX2 textures (KHR_texture_basisu)', () => {
  const KTX2_MAGIC = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
  const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const dataUri = (bytes: number[]): string =>
    `data:application/octet-stream;base64,${btoa(String.fromCharCode(...bytes))}`;

  it('chooses the KTX2 image and keeps the PNG as the fallback', async () => {
    const triangle = JSON.parse(new TextDecoder().decode(sample('Triangle', 'glTF-Embedded').bytes)) as Record<
      string,
      unknown
    >;
    const gltf = {
      ...triangle,
      extensionsUsed: ['KHR_texture_basisu'],
      images: [{ uri: dataUri([...PNG_MAGIC, 0, 0, 0, 0]) }, { uri: dataUri([...KTX2_MAGIC, 0, 0, 0, 0]) }],
      textures: [{ source: 0, extensions: { KHR_texture_basisu: { source: 1 } } }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      meshes: [{ primitives: [{ attributes: { POSITION: 1 }, indices: 0, material: 0 }] }],
    };
    const model = await parseModel(new TextEncoder().encode(JSON.stringify(gltf)));
    expect(model.images.map((i) => i.mimeType)).toEqual(['image/png', 'image/ktx2']);
    expect(model.materials[0]?.baseColorTexture).toMatchObject({ image: 1, fallbackImage: 0 });
  });
});
