import { readFileSync } from 'node:fs';
import { fc } from '@fast-check/vitest';
import { TaskError } from '@vibeglobe/worker';
import { createTranscodeKtx2 } from '@vibeglobe/worker/transcode-ktx2';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderTile } from './generate.ts';
import { encodeKtx2 } from './ktx2.ts';

/**
 * F114 in Node: random and mutated bytes through the KTX2 reader and the committed transcoder, exactly as a worker
 * runs them. Every input gives a tile or a typed error; replaying the inputs leaves the transcoder's memory as it was.
 */

/** Inputs per decoder (M3 plan §4: 2,000 in CI); `VIBEGLOBE_FUZZ_RUNS` changes it. */
const RUNS = Number(process.env['VIBEGLOBE_FUZZ_RUNS'] ?? 2000);
const ERROR_CODES = ['undecodable', 'format-unsupported'];
/** A transcode of a 256 px tile takes about 1 ms; a slow input is a hang. */
const SLOW_MS = 1000;

let memory: WebAssembly.Memory | undefined;
const transcode = createTranscodeKtx2(() =>
  WebAssembly.compile(readFileSync(new URL('../../../packages/worker/wasm/vibeglobe-basis.wasm', import.meta.url))),
);
const context = { isCancelled: () => false };
const seeds: Uint8Array[] = [];

/** Captures the memory of the transcoder instance the task creates. */
function watchInstantiation(): void {
  const instantiate = WebAssembly.instantiate.bind(WebAssembly) as (
    module: WebAssembly.Module,
    imports?: WebAssembly.Imports,
  ) => Promise<WebAssembly.Instance>;
  WebAssembly.instantiate = (async (module: WebAssembly.Module, imports?: WebAssembly.Imports) => {
    const instance = await instantiate(module, imports);
    memory = instance.exports['memory'] as WebAssembly.Memory;
    return instance;
  }) as typeof WebAssembly.instantiate;
}

async function run(bytes: Uint8Array): Promise<string> {
  const startMs = performance.now();
  try {
    await transcode({ bytes: bytes.slice().buffer, formats: ['bc', 'etc2', 'astc'] }, context);
    return 'tile';
  } catch (error) {
    if (!(error instanceof TaskError)) throw error;
    return error.code;
  } finally {
    expect(performance.now() - startMs).toBeLessThan(SLOW_MS);
  }
}

/** A real file with some bytes overwritten, flipped, cut off or repeated. */
const mutated = fc
  .record({
    seed: fc.nat(),
    edits: fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 }), fc.constantFrom('set', 'flip', 'header')), {
      minLength: 1,
      maxLength: 8,
    }),
    cut: fc.option(fc.nat()),
    repeat: fc.option(fc.tuple(fc.nat(), fc.integer({ min: 1, max: 256 }))),
  })
  .map(({ seed, edits, cut, repeat }) => {
    const source = seeds[seed % seeds.length] ?? new Uint8Array(0);
    let bytes = source.slice();
    for (const [at, value, kind] of edits) {
      // The header and index (the first 200 bytes) steer everything else, so a third of the edits land there.
      const index = kind === 'header' ? at % Math.min(200, bytes.length) : at % bytes.length;
      bytes[index] = kind === 'flip' ? (bytes[index] ?? 0) ^ (1 << (value % 8)) : value;
    }
    if (repeat) {
      const start = repeat[0] % bytes.length;
      const piece = bytes.subarray(start, start + repeat[1]);
      bytes = Uint8Array.from([...bytes.subarray(0, start), ...piece, ...bytes.subarray(start)]);
    }
    return cut === null ? bytes : bytes.subarray(0, cut % (bytes.length + 1));
  });

const random = fc.uint8Array({ maxLength: 4096 });

describe('KTX2 decoder fuzzing (F114)', () => {
  beforeAll(async () => {
    const pixels = renderTile({ pattern: 'world', scheme: 'mercator', level: 3, x: 4, y: 2, sizePx: 64 });
    const alpha = pixels.slice();
    for (let i = 3; i < alpha.length; i += 12) alpha[i] = 0;
    for (const mode of ['etc1s', 'uastc'] as const) {
      seeds.push(new Uint8Array(await encodeKtx2(pixels, 64, 64, mode)));
      seeds.push(new Uint8Array(await encodeKtx2(alpha, 64, 64, mode)));
    }
    // After the encoder has loaded: only the transcoder is instantiated from here on.
    watchInstantiation();
  });

  it(`answers ${RUNS} random and mutated files with a tile or a typed error, its memory flat across replays`, async () => {
    const outcomes = new Map<string, number>();
    const record = (outcome: string): void => void outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
    // Warm up on the valid files: the transcoder's memory grows to its working size.
    for (const seed of seeds) expect(await run(seed)).toBe('tile');
    const inputs: Uint8Array[] = [];
    await fc.assert(
      fc.asyncProperty(fc.oneof({ arbitrary: mutated, weight: 4 }, { arbitrary: random, weight: 1 }), async (bytes) => {
        inputs.push(bytes);
        const outcome = await run(bytes);
        expect(['tile', ...ERROR_CODES]).toContain(outcome);
        record(outcome);
      }),
      { numRuns: RUNS },
    );
    // The valid files still transcode: no failure left the instance broken.
    for (const seed of seeds) expect(await run(seed)).toBe('tile');
    // WebAssembly memory never shrinks: after one pass it holds the largest input's working size. Replaying the
    // same inputs must not grow it: nothing is left allocated per input.
    const afterFirstPass = memory?.buffer.byteLength ?? 0;
    for (let replay = 0; replay < 3; replay++) for (const bytes of inputs) await run(bytes);
    console.log(
      `KTX2 fuzzing: ${JSON.stringify(Object.fromEntries(outcomes))}; transcoder memory ${afterFirstPass} bytes, ` +
        `${memory?.buffer.byteLength} after 3 replays`,
    );
    expect(afterFirstPass).toBeGreaterThan(0);
    // No input grows the transcoder beyond a few tiles' working size (KB-068).
    expect(afterFirstPass).toBeLessThan(32 * 1024 * 1024);
    expect(memory?.buffer.byteLength).toBe(afterFirstPass);
  }, 300_000);
});
