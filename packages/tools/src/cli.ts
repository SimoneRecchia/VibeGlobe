/** The `vibeglobe-data` command line: the dataset pipeline and the offline package builder. */
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { datasetArea, loadConfig } from './config/load.js';
import { formatEstimate } from './estimate.js';
import { startFixtureServer } from './fixtures/server.js';
import { PROVIDER_PROFILES } from './license/profiles.js';
import { type Step, STEPS, estimateBuild, runBuild, selectedDatasets } from './pipeline/build.js';
import { verifyTerrain } from './pipeline/verify-terrain.js';
import { sourceFiles } from './sources/files.js';
import { coverage } from './tiles/area.js';
import { runPack } from './pack/pack-command.js';
import { credentialsFromEnv } from './sources/sigv4.js';

/** Input and output of a CLI run; tests replace every member. */
export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  fetch: typeof fetch;
  interactive: boolean;
  ask: (question: string) => Promise<boolean>;
  env: Record<string, string | undefined>;
}

/** Folder of the configurations shipped with the package. */
export const CONFIG_DIR = fileURLToPath(new URL('../configs/', import.meta.url));
/**
 * Default folder of build outputs and state, `node_modules/.vibeglobe-data/<config>[-sample]` inside the package:
 * ignored by git, the formatters and the linters, and kept across runs so builds resume.
 */
const BUILD_DIR = fileURLToPath(new URL('../node_modules/.vibeglobe-data/', import.meta.url));

function defaultOut(configPath: string, sample: boolean): string {
  return join(BUILD_DIR, `${basename(configPath, '.json')}${sample ? '-sample' : ''}`);
}

/** Parsed `--name value` and `--flag` options plus positional arguments. */
export interface ParsedArgs {
  positional: string[];
  options: Map<string, string | true>;
}

/** Parses arguments: `--name=value`, `--name value` and boolean `--flag`. */
export function parseArgs(args: string[], flags: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const options = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s);
    if (inline !== undefined) options.set(name as string, inline);
    else if (flags.includes(name as string)) options.set(name as string, true);
    else options.set(name as string, args[++i] ?? '');
  }
  return { positional, options };
}

function defaultConfigs(): string[] {
  try {
    return readdirSync(CONFIG_DIR).filter((f) => f.endsWith('.json') && !f.endsWith('.lock.json'));
  } catch {
    return [];
  }
}

/** The help text, listing every command and the datasets of the shipped configurations. */
export function helpText(): string {
  const datasets = defaultConfigs().map((file) => {
    const { config } = loadConfig(join(CONFIG_DIR, file));
    return `  ${basename(file)}: ${config.datasets.map((d) => `${d.id} (${d.kind})`).join(', ')}`;
  });
  return [
    'Usage: vibeglobe-data <command> [options]',
    '',
    'Dataset pipeline (each step runs the steps before it, which resume where they stopped):',
    '  estimate <config>   Tile counts, output size, download size and cost per dataset and zoom; downloads nothing',
    '  download <config>   Download the sources (after the estimate and confirmation)',
    '  convert <config>    Download, then make the sources readable (unzip, or GDAL in a pinned Docker image)',
    '  tile <config>       ... then cut and encode the tiles into the static folder',
    '  package <config>    ... then write PMTiles/MBTiles packages and license metadata (same as build)',
    '  build <config>      Run every step',
    '  verify <config>     Compare terrain heights at --points random points (default 1000) with the source DEM read by',
    '                      GDAL in the configuration’s pinned Docker image',
    '  Options: --sample (the configuration’s sample area), --dataset <id,…>,',
    '           --out <folder> (default packages/tools/node_modules/.vibeglobe-data/<config>[-sample]),',
    '           --source-url <id>=<url>,… (a mirror, a local copy or a fixture stub instead of the configured source),',
    '           --yes (confirm without a prompt; required in non-interactive runs)',
    '',
    'Offline package builder:',
    '  pack --source <url template> --profile <id> (--bbox w,s,e,n | --polygon <geojson>) --zooms <min-max>',
    '       --format pmtiles|mbtiles --out <file> [--estimate-only] [--yes]',
    '',
    '  fixtures serve      Local fixture server: the Sentinel-2 cloudless stub, a synthetic OSM extract, XYZ tiles and',
    '                      --static <folder> (use with --source-url for sample builds without real downloads)',
    '  licenses            The built-in provider profiles and whether their terms allow packaging',
    '',
    `Configurations shipped in ${CONFIG_DIR}:`,
    ...datasets,
  ].join('\n');
}

/** Parses `--source-url id=url[,id=url…]`. */
export function parseSourceUrls(text: string): Record<string, string> {
  return Object.fromEntries(
    text.split(',').map((pair) => {
      const at = pair.indexOf('=');
      if (at < 1) throw new Error(`--source-url: expected <dataset>=<url>, got "${pair}"`);
      return [pair.slice(0, at), pair.slice(at + 1)];
    }),
  );
}

function resolveConfig(name: string | undefined): string {
  if (!name) throw new Error('missing configuration file (see vibeglobe-data help)');
  return defaultConfigs().includes(name) ? join(CONFIG_DIR, name) : name;
}

async function pipelineCommand(command: Step | 'build', parsed: ParsedArgs, io: CliIo): Promise<number> {
  const configPath = resolveConfig(parsed.positional[0]);
  const sample = parsed.options.has('sample');
  const datasets = parsed.options.get('dataset');
  const credentials = credentialsFromEnv(io.env);
  const sourceUrls = parsed.options.get('source-url');
  const result = await runBuild({
    configPath,
    outDir: String(parsed.options.get('out') ?? defaultOut(configPath, sample)),
    sample,
    yes: parsed.options.has('yes'),
    interactive: io.interactive,
    until: command === 'build' ? 'package' : command,
    ...(typeof datasets === 'string' ? { datasets: datasets.split(',') } : {}),
    ...(typeof sourceUrls === 'string' ? { sourceUrls: parseSourceUrls(sourceUrls) } : {}),
    fetch: io.fetch,
    ...(credentials ? { credentials } : {}),
    ask: io.ask,
    report: io.out,
  });
  if (result.confirmed) {
    io.out(
      `Done: ${result.tilesBuilt} tiles built, ${result.tilesSkipped} skipped, ${result.transferredBytes} bytes downloaded.`,
    );
    for (const output of result.outputs) io.out(`  ${output}`);
  }
  return 0;
}

/** `verify`: checks terrain outputs against their sources with GDAL in the configuration's pinned image. */
function verifyCommand(parsed: ParsedArgs, io: CliIo): number {
  const configPath = resolveConfig(parsed.positional[0]);
  const loaded = loadConfig(configPath);
  const sample = parsed.options.has('sample');
  const root = String(parsed.options.get('out') ?? defaultOut(configPath, sample));
  const datasets = selectedDatasets(loaded, { sample }).filter((d) => d.kind === 'terrain');
  let failed = false;
  for (const dataset of datasets) {
    const area = datasetArea(loaded, dataset, sample);
    const files = sourceFiles(dataset, { kind: 'bbox', bbox: coverage(area, dataset.minZoom) });
    const points = Number(parsed.options.get('points') ?? 1000);
    const check = verifyTerrain({ dataset, area, files, root, image: loaded.config.tools.gdal, points, seed: 1 });
    io.out(
      `${dataset.id}: ${check.points} points, max error ${check.maxErrorM.toFixed(4)} m, mean ${check.meanErrorM.toFixed(4)} m ` +
        `(tolerance ${check.toleranceM.toFixed(4)} m, GDAL in ${loaded.config.tools.gdal}): ${check.passed ? 'PASS' : 'FAIL'}`,
    );
    failed ||= !check.passed;
  }
  return failed ? 1 : 0;
}

/** `fixtures serve`: the local fixture server, until the process is stopped. */
async function fixturesCommand(parsed: ParsedArgs, io: CliIo): Promise<number> {
  if (parsed.positional[0] !== 'serve')
    throw new Error('usage: vibeglobe-data fixtures serve [--port <n>] [--static <folder>]');
  const staticFolder = parsed.options.get('static');
  const { url } = await startFixtureServer({
    port: Number(parsed.options.get('port') ?? 8710),
    ...(typeof staticFolder === 'string' ? { staticFolder } : {}),
  });
  io.out(`Fixture server on ${url}: /s2/tiles/{level}/{col}/{row}.tif, /osm/<name>.osm.pbf, /xyz/{z}/{x}/{y}.png`);
  if (typeof staticFolder === 'string') io.out(`  /static/ serves ${staticFolder}`);
  return 0;
}

const FLAGS = ['sample', 'yes', 'estimate-only', 'help'] as const;

/** Runs the CLI; returns the exit code. */
export async function main(args: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = args;
  const parsed = parseArgs(rest, FLAGS);
  try {
    if (!command || command === 'help' || command === '--help') {
      io.out(helpText());
      return 0;
    }
    if (command === 'estimate') {
      const loaded = loadConfig(resolveConfig(parsed.positional[0]));
      const datasets = parsed.options.get('dataset');
      const options = {
        sample: parsed.options.has('sample'),
        ...(typeof datasets === 'string' ? { datasets: datasets.split(',') } : {}),
      };
      io.out(formatEstimate(estimateBuild(loaded, options)));
      return 0;
    }
    if (command === 'build' || (STEPS as readonly string[]).includes(command))
      return await pipelineCommand(command as Step, parsed, io);
    if (command === 'pack') return await runPack(parsed, io);
    if (command === 'verify') return verifyCommand(parsed, io);
    if (command === 'fixtures') return await fixturesCommand(parsed, io);
    if (command === 'licenses') {
      for (const p of PROVIDER_PROFILES) {
        const allowed = p.offlinePackaging && p.redistribution ? 'allowed' : `refused: ${p.forbiddingTerm ?? ''}`;
        io.out(`${p.id}: ${p.name} (${p.license}, terms read ${p.termsReadDate}) — ${allowed}`);
      }
      return 0;
    }
    io.err(`unknown command "${command}" (see vibeglobe-data help)`);
    return 2;
  } catch (error) {
    io.err((error as Error).message);
    return 1;
  }
}

/** The CLI's standard input and output. */
export function processIo(): CliIo {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    fetch: globalThis.fetch,
    interactive: Boolean(process.stdin.isTTY),
    ask: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^y(es)?$/i.test((await rl.question(question)).trim());
      } finally {
        rl.close();
      }
    },
    env: process.env,
  };
}
