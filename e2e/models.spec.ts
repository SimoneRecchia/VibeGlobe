// Models and quality track: glTF models decode in the worker program's `parse-model` task in the browser, Draco and meshopt included, and corrupt
// files fail there with a model error (F361). The conformance suite itself runs in Node (packages/models).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/** The engine's worker program, which registers `parse-model` (hook request 1 of the models and quality track). */
const WORKER = `/@fs${resolve('packages/worker/src/vibeglobe-worker.ts')}`;
const DRACO_WASM = `/@fs${resolve('node_modules/draco3d/draco_decoder.wasm')}`;
const KHRONOS = 'packages/models/src/__fixtures__/khronos';
const bytes = (path: string): number[] => [...readFileSync(`${KHRONOS}/${path}`)];

interface Reply {
  readonly inWorker: boolean;
  readonly output?: { stats: { vertices: number; triangles: number }; extensionsUsed: string[] };
  readonly error?: { code: string; message: string };
}

/** Runs `parse-model` in the worker program with the model's bytes and external files. */
function parseInWorker(page: Page, file: number[], resources: Record<string, number[]> = {}): Promise<Reply> {
  return page.evaluate(
    async ({ url, wasm, file, resources }) => {
      const worker = new Worker(url, { type: 'module' });
      const input = {
        bytes: new Uint8Array(file).buffer,
        resources: Object.fromEntries(Object.entries(resources).map(([uri, b]) => [uri, new Uint8Array(b).buffer])),
        dracoWasmUrl: wasm,
      };
      type Message =
        | { kind: 'ready' }
        | { kind: 'reply'; ok: true; output: NonNullable<Reply['output']> }
        | { kind: 'reply'; ok: false; error: { code: string; message: string } };
      const reply = await new Promise<Reply>((done) => {
        worker.onmessage = (event: MessageEvent<Message>) => {
          const message = event.data;
          // The program announces itself, then answers the task (protocol of @vibeglobe/core's worker-protocol.ts).
          if (message.kind === 'ready') worker.postMessage({ kind: 'run', id: 1, task: 'parse-model', input });
          else done(message.ok ? { inWorker: true, output: message.output } : { inWorker: true, error: message.error });
        };
      });
      worker.terminate();
      return reply;
    },
    { url: WORKER, wasm: DRACO_WASM, file, resources },
  );
}

test('Draco, meshopt and GLB models decode in a worker (F361)', async ({ page }) => {
  await page.goto('/');
  const draco = await parseInWorker(page, bytes('Box/glTF-Draco/Box.gltf'), {
    'Box.bin': bytes('Box/glTF-Draco/Box.bin'),
  });
  expect(draco.error).toBeUndefined();
  expect(draco).toMatchObject({ inWorker: true, output: { stats: { vertices: 24, triangles: 12 } } });
  expect(draco.output?.extensionsUsed).toContain('KHR_draco_mesh_compression');
  const images = Object.fromEntries(
    [0, 1, 2, 3, 4]
      .flatMap((i) => [`col${i}.png`, `row${i}.png`])
      .map((name) => [name, bytes(`MeshoptCubeTest/glTF-Meshopt/${name}`)]),
  );
  const meshopt = await parseInWorker(page, bytes('MeshoptCubeTest/glTF-Meshopt/MeshoptCubeTest.gltf'), {
    'MeshoptCubeTest.bin': bytes('MeshoptCubeTest/glTF-Meshopt/MeshoptCubeTest.bin'),
    ...images,
  });
  expect(meshopt).toMatchObject({ inWorker: true, output: { stats: { vertices: 640, triangles: 320 } } });
  const glb = await parseInWorker(page, bytes('Box/glTF-Binary/Box.glb'));
  expect(glb.output?.stats.triangles).toBe(12);
});

test('truncated and corrupted models fail in the worker with a model error (F361)', async ({ page }) => {
  await page.goto('/');
  const glb = bytes('Box/glTF-Binary/Box.glb');
  expect((await parseInWorker(page, glb.slice(0, 700))).error?.code).toBe('invalid-glb');
  const noisy = bytes('Box/glTF-Draco/Box.bin').map((b, i) => (i < 64 ? 0x5a : b));
  expect((await parseInWorker(page, bytes('Box/glTF-Draco/Box.gltf'), { 'Box.bin': noisy })).error?.code).toBe(
    'decode-failed',
  );
});
