// Packs the published packages with `npm pack`, inspects the tarballs and installs them into consumer projects, the
// way a consumer would get them from the registry (F530, F532, F559; ADR 0171).
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { ROOT_DIR, importSpecifiers, readWorkspace } from '../workspace.ts';

/** Where the release scripts write tarballs and consumer projects (ignored by git). */
const RELEASE_DIR = join(ROOT_DIR, '.release');
const TARBALL_DIR = join(RELEASE_DIR, 'tarballs');

export interface PackedPackage {
  name: string;
  version: string;
  /** Absolute path of the tarball. */
  tarball: string;
  /** `@vibeglobe/*` packages it depends on at runtime. */
  engineDependencies: string[];
}

/** The workspace packages that are published: every non-private package under `packages/`. */
function publishedPackages(): { name: string; dir: string; dependencies: Record<string, string> }[] {
  return readWorkspace()
    .filter((pkg) => pkg.dir.startsWith('packages/') && !pkg.manifest.private)
    .map((pkg) => ({ name: pkg.manifest.name as string, dir: pkg.dir, dependencies: pkg.manifest.dependencies ?? {} }));
}

/** Packs every published package into `outDir` (their `dist/` must be built) and returns the tarballs. */
export function packAll(outDir: string = TARBALL_DIR): PackedPackage[] {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const packages = publishedPackages();
  const args = ['pack', '--json', '--pack-destination', outDir, ...packages.flatMap((pkg) => ['-w', pkg.name])];
  const output = execFileSync('npm', args, { cwd: ROOT_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const packed = JSON.parse(output) as { name: string; version: string; filename: string }[];
  return packed.map((entry) => {
    const pkg = packages.find((candidate) => candidate.name === entry.name);
    if (!pkg) throw new Error(`npm packed ${entry.name}, which is not a published package`);
    return {
      name: entry.name,
      version: entry.version,
      tarball: join(outDir, entry.filename),
      engineDependencies: Object.keys(pkg.dependencies).filter((dep) => dep.startsWith('@vibeglobe/')),
    };
  });
}

/** The engine packages `names` need at runtime, themselves included, in name order. */
function engineClosure(packed: readonly PackedPackage[], names: readonly string[]): string[] {
  const seen = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    const pkg = packed.find((candidate) => candidate.name === name);
    if (!pkg) throw new Error(`${name} is not a packed package`);
    seen.add(name);
    pkg.engineDependencies.forEach(visit);
  };
  names.forEach(visit);
  return [...seen].sort();
}

/** Extracts a tarball into a new directory and returns the package root (`<dir>/package`). */
export function extract(tarball: string, into: string): string {
  mkdirSync(into, { recursive: true });
  execFileSync('tar', ['-xzf', tarball, '-C', into]);
  return join(into, 'package');
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

/** Every file path an `exports` map points to, with the condition it sits under. */
function exportTargets(exports: unknown, condition = 'default'): { condition: string; target: string }[] {
  if (typeof exports === 'string') return [{ condition, target: exports }];
  if (typeof exports !== 'object' || exports === null) return [];
  return Object.entries(exports).flatMap(([key, value]) => exportTargets(value, key.startsWith('.') ? condition : key));
}

const inside = (root: string, path: string): boolean => path === root || path.startsWith(root + sep);

/**
 * Problems of one extracted package: what F530 asks a published tarball to hold (ESM JavaScript, declarations, an
 * exports map whose every target exists, the license) and that nothing in it refers to a file outside it.
 */
export function inspectPackage(root: string): string[] {
  const problems: string[] = [];
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    type?: string;
    types?: string;
    exports?: unknown;
    license?: string;
  };
  if (manifest.type !== 'module') problems.push('package.json: "type" is not "module"');
  if (manifest.license !== 'PolyForm-Noncommercial-1.0.0') problems.push('package.json: license is not PolyForm');
  const license = join(root, 'LICENSE.md');
  if (!existsSync(license)) problems.push('LICENSE.md missing');
  else if (readFileSync(license, 'utf8') !== readFileSync(join(ROOT_DIR, 'LICENSE.md'), 'utf8'))
    problems.push("LICENSE.md differs from the repository's LICENSE.md");
  if (manifest.exports === undefined) problems.push('package.json: no "exports" map');
  const targets = exportTargets(manifest.exports);
  if (manifest.types !== undefined) targets.push({ condition: 'types', target: manifest.types });
  for (const { condition, target } of targets) {
    if (!existsSync(join(root, target))) problems.push(`exports (${condition}): ${target} is not in the tarball`);
  }
  if (!targets.some(({ condition }) => condition === 'types')) problems.push('no type declarations exported');
  const files = listFiles(root);
  for (const file of files) {
    const path = relative(root, file);
    if (/\.(js|d\.ts)$/.test(file)) {
      const content = readFileSync(file, 'utf8');
      if (file.endsWith('.js') && /\bmodule\.exports\b|\brequire\(['"]/.test(content))
        problems.push(`${path}: CommonJS, not ESM`);
      for (const specifier of importSpecifiers(content)) {
        if (specifier.startsWith('.') && !inside(root, resolve(dirname(file), specifier)))
          problems.push(`${path}: imports ${specifier}, outside the package`);
      }
    } else if (file.endsWith('.map')) {
      const map = JSON.parse(readFileSync(file, 'utf8')) as { sources?: string[] };
      for (const source of map.sources ?? []) {
        const target = resolve(dirname(file), source);
        if (!inside(root, target) || !existsSync(target))
          problems.push(`${path}: source ${source} is not in the tarball`);
      }
    }
  }
  return problems;
}

/** A fresh directory outside the repository, so module resolution cannot reach the workspace's node_modules. */
export function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `vibeglobe-${prefix}-`));
}

/**
 * Installs the engine packages `names` (and the engine packages they need) from their tarballs into `projectDir`,
 * which holds a package.json: third-party dependencies come from the public registry with no credentials.
 */
export function installTarballs(projectDir: string, packed: readonly PackedPackage[], names: readonly string[]): void {
  const manifestPath = join(projectDir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string> };
  const tarballs: Record<string, string> = {};
  for (const name of engineClosure(packed, names)) {
    tarballs[name] = `file:${packed.find((pkg) => pkg.name === name)?.tarball}`;
  }
  // Only the packages the project names are dependencies; overrides let npm satisfy the others from tarballs too.
  const dependencies = { ...manifest.dependencies };
  for (const name of names) dependencies[name] = tarballs[name] as string;
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, dependencies, overrides: tarballs }, null, 2));
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--userconfig', join(projectDir, '.npmrc-none')], {
    cwd: projectDir,
    stdio: 'inherit',
  });
}

/** The `@vibeglobe/*` packages installed in a project's node_modules. */
export function installedEnginePackages(projectDir: string): string[] {
  const dir = join(projectDir, 'node_modules/@vibeglobe');
  return existsSync(dir)
    ? readdirSync(dir)
        .map((name) => `@vibeglobe/${name}`)
        .sort()
    : [];
}
