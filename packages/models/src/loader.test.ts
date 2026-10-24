import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createModelLoader,
  createModelTasks,
  ModelError,
  poolRunner,
  type ModelTaskRunner,
  type WorkerPoolLike,
} from './index.js';
import { meshopt } from './__fixtures__/khronos.js';

const tasks = createModelTasks({ meshopt });
const context = { isCancelled: () => false };

/** Runs a task as a worker would: input and output cross a structured-clone boundary with their transfer lists. */
const workerLike: ModelTaskRunner = async (task, input, transfer) => {
  const run = tasks[task];
  if (!run) throw new Error(`unknown task ${task}`);
  const result = await run(structuredClone(input, { transfer: transfer as Transferable[] }), context);
  return structuredClone(result.output, { transfer: result.transfer as Transferable[] });
};

const FIXTURES = new URL('./__fixtures__/khronos/', import.meta.url);
const fetched: string[] = [];
const fixtureFetch = (url: string): Promise<Uint8Array> => {
  fetched.push(url);
  return Promise.resolve(new Uint8Array(readFileSync(new URL(url))));
};

describe('createModelLoader', () => {
  const loader = createModelLoader({ run: workerLike, fetch: fixtureFetch });

  it('loads a .gltf with its external buffers and images relative to its URL, decoded in the task', async () => {
    fetched.length = 0;
    const model = await loader.load({
      url: new URL('MeshoptCubeTest/glTF-Meshopt/MeshoptCubeTest.gltf', FIXTURES).href,
    });
    expect(model.stats).toMatchObject({ vertices: 640, triangles: 320 });
    expect(model.images).toHaveLength(10);
    expect(fetched.map((url) => url.split('/').pop()).sort()).toEqual(
      [
        'MeshoptCubeTest.gltf',
        'MeshoptCubeTest.bin',
        ...[0, 1, 2, 3, 4].flatMap((i) => [`col${i}.png`, `row${i}.png`]),
      ].sort(),
    );
  });

  it('loads Draco and GLB models from bytes, transferring every array back', async () => {
    const draco = await loader.load({ url: new URL('Box/glTF-Draco/Box.gltf', FIXTURES).href });
    expect(draco.meshes[0]?.primitives[0]?.indices).toBeInstanceOf(Uint32Array);
    const data = readFileSync(new URL('Box/glTF-Binary/Box.glb', FIXTURES));
    const glb = await loader.load({ data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) });
    expect(glb.stats.triangles).toBe(12);
  });

  it('rejects a broken document before fetching its files, and a missing file as missing-resource', async () => {
    fetched.length = 0;
    const bad = createModelLoader({
      run: workerLike,
      fetch: (url) =>
        url.endsWith('.gltf') ? Promise.resolve(new TextEncoder().encode('{"asset":{}}')) : fixtureFetch(url),
    });
    await expect(bad.load({ url: 'https://example.test/a.gltf' })).rejects.toMatchObject({ code: 'invalid-gltf' });
    expect(fetched).toEqual([]);
    const missing = createModelLoader({ run: workerLike, fetch: () => Promise.reject(new Error('404')) });
    await expect(missing.load({ url: 'https://example.test/a.glb' })).rejects.toMatchObject({
      code: 'missing-resource',
    });
  });

  it('keeps the model error code a worker pool reports', async () => {
    const pool: WorkerPoolLike = {
      run: (_request, done) =>
        done({
          ok: false,
          error: Object.assign(new Error('bad stream'), { code: 'task-failed', taskCode: 'decode-failed' }),
        }),
    };
    const loader = createModelLoader({ run: poolRunner(pool), fetch: fixtureFetch });
    const error: unknown = await loader
      .load({ url: new URL('Box/glTF-Binary/Box.glb', FIXTURES).href })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({ code: 'decode-failed', message: 'bad stream' });
  });
});
