import { expect, test, type Browser, type Page } from '@playwright/test';
import { openGlobe } from './support/globe.js';

/**
 * F114 in the browser: random and mutated PNG, JPEG, WebP and KTX2 bytes through the real worker program, which
 * answers each with a tile or a typed error and whose memory stays flat (M3 plan §4: 2,000 inputs per decoder).
 */

test.describe.configure({ timeout: 300_000 });

const RUNS = Number(process.env['VIBEGLOBE_FUZZ_RUNS'] ?? 2000);
/** A slower answer is a hang: a 256 px tile decodes or transcodes in a few milliseconds. */
const SLOW_MS = 5000;

interface WorkerHeap {
  usedSize: number;
  embedderHeapUsedSize: number;
  backingStorageSize: number;
}

/** Reads the heap of the page's only worker through the DevTools protocol, after a garbage collection. */
async function workerHeap(browser: Browser): Promise<number> {
  const cdp = await browser.newBrowserCDPSession();
  let sessionId: string | undefined;
  try {
    const { targetInfos } = await cdp.send('Target.getTargets');
    const workers = targetInfos.filter((target) => target.type === 'worker');
    expect(workers).toHaveLength(1);
    ({ sessionId } = await cdp.send('Target.attachToTarget', {
      targetId: workers[0]?.targetId ?? '',
      flatten: false,
    }));
    const attached = sessionId;
    const replies = new Map<number, (result: unknown) => void>();
    cdp.on('Target.receivedMessageFromTarget', (event) => {
      const message = JSON.parse(event.message) as { id: number; result: unknown };
      replies.get(message.id)?.(message.result);
    });
    let id = 0;
    const send = (method: string): Promise<unknown> =>
      new Promise((resolve) => {
        replies.set(++id, resolve);
        void cdp.send('Target.sendMessageToTarget', { sessionId: attached, message: JSON.stringify({ id, method }) });
      });
    await send('HeapProfiler.collectGarbage');
    const heap = (await send('Runtime.getHeapUsage')) as WorkerHeap;
    return heap.usedSize + heap.embedderHeapUsedSize + heap.backingStorageSize;
  } finally {
    // The attachment to the worker belongs to the browser, not to this session: left open, it outlives the test and
    // later contexts of the same browser fail to start ("Failed to find browser context").
    if (sessionId) await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
    await cdp.detach();
  }
}

/**
 * Feeds `count` inputs, from `seed`, to the worker program in the page: random bytes, and valid tiles with bytes
 * overwritten, flipped, cut off or repeated. Returns the count of each outcome and the slowest answer.
 */
async function fuzz(
  page: Page,
  seed: number,
  count: number,
  kind: 'imagery' | 'terrain' = 'imagery',
): Promise<{ outcomes: Record<string, number>; slowestMs: number }> {
  return page.evaluate(
    async ({ seed, count, kind }) => {
      const hooks = window.vibeglobePlayground;
      if (!hooks) throw new Error('no playground');
      // mulberry32: a small seeded generator, so a failure replays from its seed.
      let state = seed >>> 0;
      const random = (): number => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const int = (limit: number): number => Math.floor(random() * limit);
      const tile = await (await fetch('/fixture-tiles/fuzz/world/mercator/3/4/2.png')).blob();
      const canvas = new OffscreenCanvas(256, 256);
      canvas.getContext('2d')?.drawImage(await createImageBitmap(tile), 0, 0);
      const bytes = async (blob: Blob): Promise<Uint8Array> => new Uint8Array(await blob.arrayBuffer());
      const images = [
        { type: 'image/png', bytes: await bytes(tile) },
        { type: 'image/jpeg', bytes: await bytes(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })) },
        { type: 'image/webp', bytes: await bytes(await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 })) },
      ];
      const ktx2 = await Promise.all(
        ['etc1s', 'uastc'].map(async (mode) =>
          bytes(await (await fetch(`/fixture-tiles/fuzz/world/mercator/3/4/2.${mode}.ktx2`)).blob()),
        ),
      );
      const mutate = (source: Uint8Array): Uint8Array => {
        if (random() < 0.2) return Uint8Array.from({ length: int(4096) }, () => int(256));
        let out = source.slice();
        for (let edit = 1 + int(8); edit > 0; edit--) {
          // Headers steer everything else, so a third of the edits land in the first 200 bytes.
          const at = random() < 0.33 ? int(Math.min(200, out.length)) : int(out.length);
          out[at] = random() < 0.5 ? int(256) : (out[at] ?? 0) ^ (1 << int(8));
        }
        if (random() < 0.3) {
          const start = int(out.length);
          const piece = out.slice(start, start + 1 + int(256));
          out = Uint8Array.from([...out.subarray(0, start), ...piece, ...out.subarray(start)]);
        }
        return random() < 0.3 ? out.slice(0, int(out.length + 1)) : out;
      };
      // Terrain (F131): Terrarium and Terrain-RGB heightmaps and quantized-mesh tiles, plain and gzip-compressed.
      const terrainBytes = async (path: string): Promise<Uint8Array> => bytes(await (await fetch(path)).blob());
      const mesh = await terrainBytes('/fixture-tiles/fuzz/terrain/geographic/8/261/165.terrain');
      const gzip = async (raw: Uint8Array): Promise<Uint8Array> =>
        bytes(await new Response(new Blob([raw.slice()]).stream().pipeThrough(new CompressionStream('gzip'))).blob());
      const terrain =
        kind === 'terrain'
          ? [
              {
                encoding: 'terrarium',
                bytes: await terrainBytes('/fixture-tiles/fuzz/terrain/mercator/8/132/90.terrarium.png'),
              },
              {
                encoding: 'terrain-rgb',
                bytes: await terrainBytes('/fixture-tiles/fuzz/terrain/mercator/8/132/90.terrain-rgb.png'),
              },
              { encoding: 'quantized-mesh', bytes: mesh },
              { encoding: 'quantized-mesh', bytes: await gzip(mesh) },
            ]
          : [];
      const terrainRun = () => {
        const sample = terrain[int(terrain.length)] ?? terrain[0];
        const input = mutate(sample?.bytes ?? new Uint8Array(0)).buffer;
        return {
          task: 'decode-terrain',
          input: { bytes: input, encoding: sample?.encoding, maxErrorMeters: 5, meshCells: 32 },
          transfer: [input],
        };
      };
      const outcomes: Record<string, number> = {};
      let slowestMs = 0;
      for (let i = 0; i < count; i++) {
        // Every decoder gets `count` inputs: the image decoder (three formats) and the KTX2 transcoder, or the terrain
        // decoder.
        for (const run of kind === 'terrain'
          ? [terrainRun]
          : [
              () => {
                const image = images[int(images.length)] ?? images[0];
                const input = mutate(image?.bytes ?? new Uint8Array(0)).buffer;
                const type = random() < 0.1 ? '' : (image?.type ?? '');
                return { task: 'decode-image', input: { bytes: input, contentType: type }, transfer: [input] };
              },
              () => {
                const input = mutate(ktx2[int(ktx2.length)] ?? new Uint8Array(0)).buffer;
                return {
                  task: 'transcode-ktx2',
                  input: { bytes: input, formats: ['bc', 'etc2', 'astc'] },
                  transfer: [input],
                };
              },
            ]) {
          const { task, input, transfer } = run();
          const startMs = performance.now();
          const outcome = await hooks.workerTask(task, input, transfer);
          slowestMs = Math.max(slowestMs, performance.now() - startMs);
          const key = `${task} ${outcome}`;
          outcomes[key] = (outcomes[key] ?? 0) + 1;
        }
      }
      return { outcomes, slowestMs };
    },
    { seed, count, kind },
  );
}

test('the worker program answers random and mutated image and KTX2 bytes with a tile or a typed error, its memory flat (F114)', async ({
  page,
  browser,
}) => {
  // No imagery: the fuzzing worker is the page's only worker.
  await openGlobe(page, 'backend=webgl2');
  const seed = Number(process.env['VIBEGLOBE_FC_SEED'] ?? Date.now() % 1_000_000);
  console.log(`decoder fuzzing seed ${seed} (replay: VIBEGLOBE_FC_SEED=${seed})`);
  // A first pass brings the worker to its working size: the transcoder's memory never shrinks.
  const first = await fuzz(page, seed, RUNS);
  const afterFirst = await workerHeap(browser);
  const replay = await fuzz(page, seed, RUNS);
  const afterReplay = await workerHeap(browser);
  console.log(
    `decoder fuzzing: ${JSON.stringify(first.outcomes)}; slowest ${first.slowestMs.toFixed(0)} ms; ` +
      `worker memory ${afterFirst} → ${afterReplay} bytes after the replay`,
  );
  const allowed = [
    'decode-image ok',
    'decode-image undecodable',
    'transcode-ktx2 ok',
    'transcode-ktx2 undecodable',
    'transcode-ktx2 format-unsupported',
  ];
  for (const key of Object.keys(first.outcomes)) expect(allowed).toContain(key);
  expect(replay.outcomes).toEqual(first.outcomes);
  // Both decoders also succeeded: the mutations leave some inputs valid.
  expect(first.outcomes['decode-image ok']).toBeGreaterThan(0);
  expect(first.outcomes['transcode-ktx2 ok']).toBeGreaterThan(0);
  expect(Math.max(first.slowestMs, replay.slowestMs)).toBeLessThan(SLOW_MS);
  // No input grows the worker beyond a few tiles' working size (KB-068: a declared level size once grew it to 272 MB),
  // and replaying the same inputs leaves nothing behind (garbage collection noise aside).
  expect(afterFirst).toBeLessThan(32 * 1024 * 1024);
  expect(afterReplay - afterFirst).toBeLessThan(256 * 1024);
});

test('the worker program answers random and mutated terrain tiles with a height grid or a typed error, its memory flat (F131)', async ({
  page,
  browser,
}) => {
  await openGlobe(page, 'backend=webgl2');
  const seed = Number(process.env['VIBEGLOBE_FC_SEED'] ?? Date.now() % 1_000_000);
  console.log(`terrain decoder fuzzing seed ${seed} (replay: VIBEGLOBE_FC_SEED=${seed})`);
  const first = await fuzz(page, seed, RUNS, 'terrain');
  const afterFirst = await workerHeap(browser);
  const replay = await fuzz(page, seed, RUNS, 'terrain');
  const afterReplay = await workerHeap(browser);
  console.log(
    `terrain decoder fuzzing: ${JSON.stringify(first.outcomes)}; slowest ${first.slowestMs.toFixed(0)} ms; ` +
      `worker memory ${afterFirst} → ${afterReplay} bytes after the replay`,
  );
  for (const key of Object.keys(first.outcomes))
    expect(['decode-terrain ok', 'decode-terrain undecodable']).toContain(key);
  expect(replay.outcomes).toEqual(first.outcomes);
  expect(first.outcomes['decode-terrain ok']).toBeGreaterThan(0);
  expect(first.outcomes['decode-terrain undecodable']).toBeGreaterThan(0);
  expect(Math.max(first.slowestMs, replay.slowestMs)).toBeLessThan(SLOW_MS);
  expect(afterFirst).toBeLessThan(32 * 1024 * 1024);
  expect(afterReplay - afterFirst).toBeLessThan(256 * 1024);
});
