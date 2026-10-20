// Vitest setup for property-based tests (ADR 0012): a reproducible seed in CI, derived from the commit, and a random
// one locally unless VIBEGLOBE_FC_SEED is set; VIBEGLOBE_FC_RUNS raises the number of runs per property.
import fc from 'fast-check';

/** Derives a 31-bit seed from a commit hash, so a CI failure replays from the commit alone. */
export function seedFromCommit(sha: string): number {
  let hash = 0;
  for (const char of sha) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0;
  return hash & 0x7fffffff;
}

/** Chooses the seed and run count for this test run from the environment. */
export function propertyConfig(env: Record<string, string | undefined>): { seed: number; numRuns: number } {
  const explicit = env['VIBEGLOBE_FC_SEED'];
  const commit = env['GITHUB_SHA'];
  const seed =
    explicit !== undefined
      ? Number.parseInt(explicit, 10)
      : commit !== undefined
        ? seedFromCommit(commit)
        : Math.floor(Math.random() * 0x7fffffff);
  const runs = env['VIBEGLOBE_FC_RUNS'];
  return { seed, numRuns: runs === undefined ? 200 : Number.parseInt(runs, 10) };
}

const config = propertyConfig(process.env);
fc.configureGlobal(config);
console.log(`[property tests] seed ${config.seed}, ${config.numRuns} runs (replay: VIBEGLOBE_FC_SEED=${config.seed})`);
