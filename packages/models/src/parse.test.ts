import { describe, expect, it } from 'vitest';
import { sample } from './__fixtures__/khronos.js';
import { ModelError, parseGlb, validateGltf } from './index.js';

/** A GLB with the given JSON and optional BIN chunk, padded as the specification asks. */
function glb(json: unknown, bin?: Uint8Array): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = Math.ceil(text.length / 4) * 4;
  const binLength = bin ? Math.ceil(bin.length / 4) * 4 : 0;
  const total = 12 + 8 + jsonLength + (bin ? 8 + binLength : 0);
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(0x20, 20, 20 + jsonLength);
  bytes.set(text, 20);
  if (bin) {
    view.setUint32(20 + jsonLength, binLength, true);
    view.setUint32(24 + jsonLength, 0x004e4942, true);
    bytes.set(bin, 28 + jsonLength);
  }
  return bytes;
}

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof ModelError ? error.code : `not a ModelError: ${String(error)}`;
  }
  return undefined;
};

describe('parseGlb', () => {
  it('splits the JSON and BIN chunks', () => {
    const { json, bin } = parseGlb(glb({ asset: { version: '2.0' } }, new Uint8Array([1, 2, 3, 4])));
    expect(JSON.parse(json)).toEqual({ asset: { version: '2.0' } });
    expect([...(bin ?? [])]).toEqual([1, 2, 3, 4]);
  });

  it.each([
    ['a short header', (b: Uint8Array) => b.subarray(0, 8), 'invalid-glb'],
    ['a wrong magic', (b: Uint8Array) => (b.set([0], 0), b), 'invalid-glb'],
    ['version 1', (b: Uint8Array) => (b.set([1], 4), b), 'unsupported'],
    ['a length past the end', (b: Uint8Array) => b.subarray(0, b.length - 4), 'invalid-glb'],
    ['a chunk past the end', (b: Uint8Array) => (new DataView(b.buffer).setUint32(12, 4096, true), b), 'invalid-glb'],
    [
      'a BIN chunk first',
      (b: Uint8Array) => (new DataView(b.buffer).setUint32(16, 0x004e4942, true), b),
      'invalid-glb',
    ],
  ])('rejects %s', (_, corrupt, code) => {
    expect(codeOf(() => parseGlb(corrupt(glb({ asset: { version: '2.0' } }))))).toBe(code);
  });
});

type Gltf = Record<string, unknown>;

/** Item `index` of the array `key` of a JSON object. */
function item(owner: Gltf, key: string, index: number): Gltf {
  const value = (owner[key] as Gltf[] | undefined)?.[index];
  if (!value) throw new Error(`${key}[${index}] missing`);
  return value;
}

describe('validateGltf', () => {
  const box = (): Record<string, unknown> =>
    JSON.parse(new TextDecoder().decode(sample('Box', 'glTF').bytes)) as Record<string, unknown>;
  const mutate = (change: (gltf: Gltf) => void): unknown => {
    const gltf = box();
    change(gltf);
    return gltf;
  };

  it('accepts the Box sample', () => {
    const doc = validateGltf(box());
    expect([doc.meshes.length, doc.nodes.length, doc.accessors.length]).toEqual([1, 2, 3]);
  });

  it.each([
    ['glTF 1.0', (g: Gltf) => (g['asset'] = { version: '1.0' }), 'unsupported'],
    ['an unknown required extension', (g: Gltf) => (g['extensionsRequired'] = ['KHR_unknown']), 'unsupported'],
    ['no asset', (g: Gltf) => delete g['asset'], 'invalid-gltf'],
  ])('rejects %s', (_, change, code) => {
    expect(codeOf(() => validateGltf(mutate(change)))).toBe(code);
  });

  it.each([
    ['a dangling node mesh', 'nodes[1].mesh', (g: Gltf) => (item(g, 'nodes', 1)['mesh'] = 7)],
    ['a node cycle', 'nodes', (g: Gltf) => (item(g, 'nodes', 1)['children'] = [0])],
    ['an accessor past its view', 'accessors[1]', (g: Gltf) => (item(g, 'accessors', 1)['count'] = 9999)],
    ['a view past its buffer', 'bufferViews[0]', (g: Gltf) => (item(g, 'bufferViews', 0)['byteLength'] = 99999)],
    ['an unknown component type', 'componentType', (g: Gltf) => (item(g, 'accessors', 0)['componentType'] = 1)],
    [
      'a primitive without POSITION',
      'attributes',
      (g: Gltf) => (item(item(g, 'meshes', 0), 'primitives', 0)['attributes'] = {}),
    ],
    ['a non-root scene node', 'scenes[0].nodes', (g: Gltf) => (item(g, 'scenes', 0)['nodes'] = [0, 1])],
  ])('rejects %s, naming the path', (_, path, change) => {
    try {
      validateGltf(mutate(change));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ModelError);
      expect((error as ModelError).code).toBe('invalid-gltf');
      expect((error as ModelError).message).toContain(path);
    }
  });
});
