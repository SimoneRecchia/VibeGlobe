// The aggregate fuzz suite (F513, ADR 0162): every target of `fuzz-targets.ts` gets its saved regression inputs, then
// its configured number of mutated inputs from a seeded generator. A crash (an exception the target does not
// document) or a hang (a call past its time limit) fails the test and saves the input under
// `fuzz-regressions/<target>/`, where every later run replays it. Runs in CI with the other script tests (Vitest's
// `scripts` project). `VIBEGLOBE_FUZZ_RUNS` scales the iterations (2,000 is the configured count), and
// `VIBEGLOBE_FUZZ_SEED` replays a run.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { seeded } from '../../e2e/robustness/support/probes.ts';
import { REQUIRED_KINDS, TARGETS, type FuzzTarget } from './fuzz-targets.ts';

const SCALE = Number(process.env['VIBEGLOBE_FUZZ_RUNS'] ?? 2000) / 2000;
const SEED = Number(process.env['VIBEGLOBE_FUZZ_SEED'] ?? 0x5eed);
const REGRESSIONS = new URL('fuzz-regressions/', import.meta.url);
const FAIL_ON_KNOWN_BUGS = process.env['VIBEGLOBE_FUZZ_KNOWN_BUGS'] === '1';

/** Values that break parsers that trust JSON shapes. */
const ODD_VALUES: readonly unknown[] = [
  null,
  -1,
  0,
  1e308,
  -1e308,
  2 ** 53,
  0.5,
  '',
  'x'.repeat(10_000),
  [],
  {},
  [[[[[[]]]]]],
  true,
  '__proto__',
  { length: 1e9 },
];

type Random = () => number;

/** Mutates bytes: random bytes, flips, overwrites, cuts, repeats and splices of the seed. */
function mutateBytes(seed: Uint8Array, random: Random): Uint8Array {
  const int = (limit: number): number => Math.floor(random() * limit);
  const bytes = seed.slice();
  switch (int(6)) {
    case 0:
      return Uint8Array.from({ length: int(512) }, () => int(256));
    case 1:
      for (let i = 0, n = 1 + int(8); i < n && bytes.length > 0; i++) {
        const at = int(bytes.length);
        bytes[at] = (bytes[at] ?? 0) ^ (1 << int(8));
      }
      return bytes;
    case 2:
      for (let i = 0, n = 1 + int(16); i < n && bytes.length > 0; i++)
        bytes[int(bytes.length)] = [0, 0xff, 0x7f, 0x80][int(4)] ?? 0;
      return bytes;
    case 3:
      return bytes.subarray(0, int(bytes.length + 1));
    case 4: {
      const start = int(bytes.length + 1);
      const piece = bytes.subarray(start, start + int(64));
      const out = new Uint8Array(bytes.length + piece.length * 4);
      out.set(bytes.subarray(0, start));
      for (let i = 0; i < 4; i++) out.set(piece, start + i * piece.length);
      out.set(bytes.subarray(start), start + piece.length * 4);
      return out;
    }
    default: {
      const at = int(bytes.length + 1);
      const insert = Uint8Array.from({ length: 1 + int(32) }, () => int(256));
      return new Uint8Array([...bytes.subarray(0, at), ...insert, ...bytes.subarray(at)]);
    }
  }
}

/** Replaces one value of a JSON document (any depth) by an odd value, or removes it. */
function mutateJson(seed: Uint8Array, random: Random): Uint8Array | undefined {
  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder().decode(seed));
  } catch {
    return undefined;
  }
  const holders: [Record<string, unknown> | unknown[], string | number][] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        holders.push([value, i]);
        walk(item);
      });
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        holders.push([value as Record<string, unknown>, key]);
        walk(item);
      }
    }
  };
  walk(document);
  for (let i = 0, n = 1 + Math.floor(random() * 3); i < n && holders.length > 0; i++) {
    const [holder, key] = holders[Math.floor(random() * holders.length)] ?? [];
    if (!holder || key === undefined) continue;
    const odd = ODD_VALUES[Math.floor(random() * ODD_VALUES.length)];
    if (random() < 0.2 && !Array.isArray(holder)) Reflect.deleteProperty(holder, key);
    else (holder as Record<string | number, unknown>)[key] = structuredClone(odd);
  }
  return new TextEncoder().encode(JSON.stringify(document));
}

/** Inserts, deletes or duplicates characters of a text, and occasionally its markup brackets and quotes. */
function mutateText(seed: Uint8Array, random: Random): Uint8Array {
  const text = new TextDecoder().decode(seed);
  const int = (limit: number): number => Math.floor(random() * limit);
  const at = int(text.length + 1);
  const pieces = ['<', '>', '"', "'", '&', '&#xFFFF;', '</', '<![CDATA[', ']]>', '\u0000', '�', '-', 'e999', ' '];
  const piece = pieces[int(pieces.length)] ?? '';
  const out =
    random() < 0.5 ? text.slice(0, at) + piece + text.slice(at) : text.slice(0, at) + text.slice(at + int(64));
  return new TextEncoder().encode(out);
}

/** One input for a target: a mutation of one of its seeds. */
function nextInput(target: FuzzTarget, seeds: readonly Uint8Array[], random: Random): Uint8Array {
  const seed = seeds[Math.floor(random() * seeds.length)] ?? new Uint8Array();
  const choice = random();
  if (target.text && choice < 0.4) return mutateJson(seed, random) ?? mutateText(seed, random);
  if (target.text && choice < 0.7) return mutateText(seed, random);
  return mutateBytes(seed, random);
}

/** Runs one input: undefined when it passed, else what went wrong. */
async function check(target: FuzzTarget, input: Uint8Array): Promise<string | undefined> {
  const started = performance.now();
  try {
    await target.run(input.slice());
  } catch (error) {
    if (!target.allowed(error))
      return `crash: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`;
  }
  const elapsedMs = performance.now() - started;
  return elapsedMs > target.timeLimitMs ? `hang: ${elapsedMs.toFixed(0)} ms > ${target.timeLimitMs} ms` : undefined;
}

/** The open bug a problem matches, when the run leaves known bugs out (the default). */
function knownBug(target: FuzzTarget, problem: string): string | undefined {
  if (FAIL_ON_KNOWN_BUGS) return undefined;
  return target.knownBugs?.find((bug) => bug.pattern.test(problem))?.id;
}

/** Saves a failing input as a regression fixture; returns its path. */
function saveRegression(target: FuzzTarget, input: Uint8Array): string {
  const dir = new URL(`${target.name}/`, REGRESSIONS);
  mkdirSync(dir, { recursive: true });
  const name = `${createHash('sha256').update(input).digest('hex').slice(0, 16)}.bin`;
  writeFileSync(new URL(name, dir), input);
  return `scripts/robustness/fuzz-regressions/${target.name}/${name}`;
}

/** The saved regression inputs of a target. */
function regressions(target: FuzzTarget): Uint8Array[] {
  const dir = new URL(`${target.name}/`, REGRESSIONS);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).map((name) => new Uint8Array(readFileSync(new URL(name, dir))));
}

describe('the aggregate fuzz suite (F513)', () => {
  it('lists a target for every decoder and parser kind, each with valid seeds', async () => {
    expect(new Set(TARGETS.map((target) => target.kind))).toEqual(new Set(REQUIRED_KINDS));
    expect(new Set(TARGETS.map((target) => target.name)).size).toBe(TARGETS.length);
    for (const target of TARGETS) {
      const seeds = await target.seeds();
      expect(seeds.length, target.name).toBeGreaterThan(0);
      // A seed is a valid input: it must pass, or the mutations start from noise.
      for (const seed of seeds) expect(await check(target, seed), target.name).toBeUndefined();
    }
  });

  for (const [index, target] of TARGETS.entries()) {
    const iterations = Math.max(1, Math.round(target.iterations * SCALE));
    it(`${target.name} (${target.kind}): ${iterations} mutated inputs and every saved regression, no crash or hang`, async () => {
      const failures: string[] = [];
      const known = new Map<string, number>();
      const count = (bug: string): void => void known.set(bug, (known.get(bug) ?? 0) + 1);
      for (const input of regressions(target)) {
        const problem = await check(target, input);
        const bug = problem && knownBug(target, problem);
        if (bug) count(bug);
        else if (problem) failures.push(`regression: ${problem}`);
      }
      const seeds = await target.seeds();
      const random = seeded(SEED + index);
      for (let i = 0; i < iterations && failures.length < 5; i++) {
        const input = nextInput(target, seeds, random);
        const problem = await check(target, input);
        if (!problem) continue;
        const bug = knownBug(target, problem);
        if (bug) {
          count(bug);
          continue;
        }
        const path = saveRegression(target, input);
        failures.push(
          `input ${i} (seed ${SEED + index}), saved as ${path}: ${problem.split('\n').slice(0, 4).join(' | ')}`,
        );
      }
      if (known.size > 0) console.warn(`[fuzz] ${target.name}: open known bugs hit ${JSON.stringify([...known])}`);
      expect(failures).toEqual([]);
    }, 300_000);
  }
});
