/**
 * Geometry of vector tile meshes (ADR 0131): the attributes interleaved into two vertex buffers, the fixed geometry
 * and the paint (colors, parameters and draping heights, rewritten in place on paint and terrain changes), so a mesh
 * stays within WebGPU's limit of eight vertex buffers whatever its kind.
 */
import { BufferAttribute, BufferGeometry, InterleavedBuffer, InterleavedBufferAttribute } from 'three/webgpu';
import type { VectorMeshData, VectorMeshUpdate } from './vector-target.js';

type Field = readonly [name: string, size: number, array: Float32Array | undefined];

/** The paint fields: attribute name, size and the key of `VectorMeshUpdate` they come from. */
const PAINT: readonly (readonly [string, number, keyof VectorMeshUpdate])[] = [
  ['vtColorA', 4, 'colorA'],
  ['vtColorB', 4, 'colorB'],
  ['vtParamsA', 4, 'paramsA'],
  ['vtParamsB', 4, 'paramsB'],
  ['vtGround', 1, 'ground'],
  ['vtStroke', 4, 'stroke'],
];

function interleave(geometry: BufferGeometry, fields: readonly Field[], count: number): InterleavedBuffer {
  const present = fields.filter((f) => f[2] !== undefined);
  const stride = present.reduce((sum, f) => sum + f[1], 0);
  const data = new Float32Array(stride * count);
  const buffer = new InterleavedBuffer(data, stride);
  let offset = 0;
  for (const [name, size, array] of present) {
    if (array !== undefined) {
      for (let v = 0; v < count; v++)
        for (let c = 0; c < size; c++) data[v * stride + offset + c] = array[v * size + c] ?? 0;
    }
    geometry.setAttribute(name, new InterleavedBufferAttribute(buffer, size, offset));
    offset += size;
  }
  return buffer;
}

/** The geometry of a mesh: its fixed attributes in one buffer, its paint in another (`userData.paint`). */
export function vectorGeometry(data: VectorMeshData): BufferGeometry {
  const g = new BufferGeometry();
  const count = data.positions.length / 3;
  interleave(
    g,
    [
      ['position', 3, data.positions],
      ['tileNormal', 3, data.normals],
      ['tilePlane', 4, data.planes],
      ['vtTile', 2, data.tile],
      ['vtSidePosition', 3, data.side?.positions],
      ['vtSideNormal', 3, data.side?.normals],
      ['vtSidePlane', 4, data.side?.planes],
      ['vtLine', 4, data.line],
      ['vtHeight', 1, data.height],
      ['vtTop', 1, data.top],
      ['vtShadeNormal', 3, data.shadeNormals],
      ['vtCorner', 2, data.corners],
    ],
    count,
  );
  g.userData['paint'] = interleave(
    g,
    PAINT.map(([name, size, key]) => [name, size, data[key]] as const),
    count,
  );
  g.setIndex(new BufferAttribute(data.indices, 1));
  return g;
}

/** Rewrites paint attributes of a geometry in place; arrays of another length than the mesh's are ignored. */
export function updateVectorGeometry(g: BufferGeometry, update: VectorMeshUpdate): void {
  const buffer = g.userData['paint'] as InterleavedBuffer | undefined;
  if (buffer === undefined) return;
  const data = buffer.array as Float32Array;
  const count = data.length / buffer.stride;
  for (const [name, size, key] of PAINT) {
    const array = update[key];
    const attribute = g.getAttribute(name) as InterleavedBufferAttribute | undefined;
    if (array === undefined || attribute === undefined || array.length !== count * size) continue;
    for (let v = 0; v < count; v++)
      for (let c = 0; c < size; c++) data[v * buffer.stride + attribute.offset + c] = array[v * size + c] ?? 0;
  }
  buffer.needsUpdate = true;
}
