// Truncated and corrupted models (F361): the loader rejects them with a ModelError, never with anything else.
import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { sample, type SampleFile } from './__fixtures__/khronos.js';
import { loadDraco3d, ModelError, parseModel } from './index.js';

const draco = loadDraco3d();

/** Parses and reports the outcome: 'ok', or the ModelError code; any other failure fails the test. */
async function outcome(file: SampleFile): Promise<string> {
  try {
    await parseModel(file.bytes, { resources: file.resources, draco });
    return 'ok';
  } catch (error) {
    if (error instanceof ModelError) return error.code;
    throw error;
  }
}

const GLB = sample('Box', 'glTF-Binary');
const DRACO = sample('Box', 'glTF-Draco');
const MESHOPT = sample('MeshoptCubeTest', 'glTF-Meshopt');

/** Replaces one external file of a sample. */
const withResource = (file: SampleFile, uri: string, bytes: Uint8Array): SampleFile => ({
  bytes: file.bytes,
  resources: { ...file.resources, [uri]: bytes },
});

describe('truncated files', () => {
  test.prop([fc.nat()])('a truncated GLB is rejected', async (cut) => {
    const bytes = GLB.bytes.subarray(0, cut % GLB.bytes.length);
    expect(await outcome({ bytes, resources: {} })).not.toBe('ok');
  });

  it('a truncated external buffer is rejected', async () => {
    const bin = DRACO.resources['Box.bin'] ?? new Uint8Array();
    expect(await outcome(withResource(DRACO, 'Box.bin', bin.subarray(0, bin.length - 1)))).toBe('invalid-gltf');
  });

  it('a missing external file is rejected', async () => {
    expect(await outcome({ bytes: DRACO.bytes, resources: {} })).toBe('missing-resource');
  });

  it('an empty file and plain text are rejected', async () => {
    expect(await outcome({ bytes: new Uint8Array(), resources: {} })).toBe('invalid-json');
    expect(await outcome({ bytes: new TextEncoder().encode('not a model'), resources: {} })).toBe('invalid-json');
  });
});

describe('corrupted bytes', () => {
  const flip = (bytes: Uint8Array, at: number, value: number): Uint8Array => {
    const copy = bytes.slice();
    copy[at % copy.length] = value;
    return copy;
  };

  test.prop([fc.nat(), fc.integer({ min: 0, max: 255 })])(
    'a corrupted GLB resolves or rejects with a ModelError',
    async (at, value) => {
      await outcome({ bytes: flip(GLB.bytes, at, value), resources: {} });
    },
  );

  test.prop([fc.nat(), fc.integer({ min: 0, max: 255 })])(
    'a corrupted Draco stream resolves or rejects with a ModelError',
    async (at, value) => {
      const bin = DRACO.resources['Box.bin'] ?? new Uint8Array();
      // The first 1,000 bytes of Box.bin are its Draco stream: corrupt those.
      await outcome(withResource(DRACO, 'Box.bin', flip(bin, at % Math.min(bin.length, 1000), value)));
    },
  );

  test.prop([fc.nat(), fc.integer({ min: 0, max: 255 })])(
    'a corrupted meshopt buffer resolves or rejects with a ModelError',
    async (at, value) => {
      const bin = MESHOPT.resources['MeshoptCubeTest.bin'] ?? new Uint8Array();
      await outcome(withResource(MESHOPT, 'MeshoptCubeTest.bin', flip(bin, at, value)));
    },
    60_000,
  );

  it('a Draco stream replaced by noise is rejected as decode-failed', async () => {
    const bin = (DRACO.resources['Box.bin'] ?? new Uint8Array()).slice();
    bin.fill(0x5a, 0, 64);
    expect(await outcome(withResource(DRACO, 'Box.bin', bin))).toBe('decode-failed');
  });

  it('a model larger than the limit is rejected before decoding', async () => {
    await expect(parseModel(GLB.bytes, { limits: { maxBytes: 100 } })).rejects.toMatchObject({ code: 'too-large' });
  });

  it('a Draco model without a Draco decoder is rejected as unsupported', async () => {
    await expect(parseModel(DRACO.bytes, { resources: DRACO.resources })).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});
