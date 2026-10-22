import { type CheckResult, check } from './support.js';

/**
 * The shared conformance suite of parsers and decoders (vector formats, capabilities documents): expected output for
 * recorded and synthetic fixtures, and fuzzing that mutates the fixtures (bit flips, truncation, splicing) and asserts
 * no input makes the parser throw or hang.
 */
export interface ParserConformanceSubject<TInput extends string | Uint8Array, TOutput> {
  readonly name: string;
  /** The parser under test; it must report problems in its result, never throw. */
  parse(input: TInput): TOutput | Promise<TOutput>;
  /** Fixtures with a check of the parsed output that returns a failure message, or undefined when correct. */
  readonly fixtures: readonly {
    readonly name: string;
    readonly input: TInput;
    expect(output: TOutput): string | undefined;
  }[];
  /** Mutated inputs per fixture (default 200). */
  readonly fuzzRuns?: number;
}

/** A small seeded generator (mulberry32), so fuzz failures reproduce. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A mutated copy of `input`: flipped bytes or characters, a truncation, or a duplicated slice. */
export function mutate<T extends string | Uint8Array>(input: T, random: () => number): T {
  const length = input.length;
  const at = Math.floor(random() * Math.max(1, length));
  const kind = Math.floor(random() * 4);
  if (typeof input === 'string') {
    if (kind === 0) return input.slice(0, at) as T;
    if (kind === 1)
      return (input.slice(0, at) + String.fromCharCode(Math.floor(random() * 128)) + input.slice(at + 1)) as T;
    if (kind === 2) return (input.slice(0, at) + input.slice(Math.floor(random() * length))) as T;
    return (input.slice(0, at) + '<"]}\u0000' + input.slice(at)) as T;
  }
  const bytes = input as Uint8Array;
  if (kind === 0) return bytes.slice(0, at) as T;
  const copy = bytes.slice();
  if (kind === 1) {
    for (let i = 0; i < 1 + Math.floor(random() * 8); i++) {
      const j = Math.floor(random() * length);
      copy[j] = (copy[j] ?? 0) ^ (1 << Math.floor(random() * 8));
    }
    return copy as T;
  }
  if (kind === 2) {
    const out = new Uint8Array(length + 16);
    out.set(bytes.subarray(0, at));
    out.set(bytes.subarray(Math.floor(random() * length)).subarray(0, length + 16 - at), at);
    return out as T;
  }
  for (let i = at; i < Math.min(length, at + 8); i++) copy[i] = 0xff;
  return copy as T;
}

/** Runs the parser suite and returns every check with its outcome. */
export async function runParserConformance<TInput extends string | Uint8Array, TOutput>(
  subject: ParserConformanceSubject<TInput, TOutput>,
  seed = 1,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const fixture of subject.fixtures) {
    let failure: string | undefined;
    try {
      failure = fixture.expect(await subject.parse(fixture.input));
    } catch (error) {
      failure = `threw ${String(error)}`;
    }
    results.push(check('parsing', `parses ${fixture.name}`, failure === undefined, failure));
  }
  const random = generator(seed);
  const runs = subject.fuzzRuns ?? 200;
  let thrown: string | undefined;
  for (const fixture of subject.fixtures) {
    for (let i = 0; i < runs && thrown === undefined; i++) {
      const input = mutate(fixture.input, random);
      try {
        await subject.parse(input);
      } catch (error) {
        thrown = `${fixture.name}, run ${i} (seed ${seed}): ${String(error)}`;
      }
    }
  }
  results.push(check('fuzzing', 'no mutated input makes the parser throw', thrown === undefined, thrown));
  return results.map((r) => ({ ...r, subject: subject.name }));
}
