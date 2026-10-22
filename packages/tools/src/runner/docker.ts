/**
 * The only way the pipeline runs an external tool (ADR 0024): `docker run` of an image pinned by digest, without
 * network, with only the build folder mounted.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PINNED_IMAGE } from '../config/load.js';

/** One external tool invocation. */
export interface ToolRun {
  /** Image reference pinned by digest. */
  image: string;
  /** Host folder mounted at `/work`; tool paths are relative to it. */
  folder: string;
  command: string[];
}

/** The `docker` arguments of a run; refuses an image that is not pinned by digest. */
function dockerArgs(run: ToolRun): string[] {
  if (!PINNED_IMAGE.test(run.image)) throw new Error(`refusing to run ${run.image}: images must be pinned by digest`);
  const user = typeof process.getuid === 'function' ? ['--user', `${process.getuid()}:${process.getgid?.() ?? 0}`] : [];
  return [
    'run',
    '--rm',
    '--network',
    'none',
    ...user,
    '-v',
    // Docker reads a relative path as the name of a volume, so the folder is made absolute (DP-001).
    `${resolve(run.folder)}:/work`,
    '-w',
    '/work',
    run.image,
    ...run.command,
  ];
}

/** Runs a tool with optional standard input; returns its standard output, throws with its errors when it fails. */
export function runTool(run: ToolRun, input?: string, spawn: typeof spawnSync = spawnSync): string {
  const args = dockerArgs(run);
  if (input !== undefined) args.splice(1, 0, '-i');
  const result = spawn('docker', args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
  if (result.error) throw new Error(`docker could not start: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(`${run.command.join(' ')} failed in ${run.image} (exit ${result.status}):\n${result.stderr}`);
  return String(result.stdout);
}
