// Packs the published packages with `npm pack`, inspects the tarballs and installs them into consumer projects, the
// way a consumer would get them from the registry (F530, F532, F559; ADR 0171).
import { execFileSync } from 'node:child_process';
import {
  cpSync,
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
import { ALLOWED_LICENSES, FONT_LICENSES } from '../licenses.ts';
import { ROOT_DIR, enginePackages, importSpecifiers } from '../workspace.ts';

/** Where the release scripts write tarballs and consumer projects (ignored by git). */
const RELEASE_DIR = join(ROOT_DIR, '.release');
const TARBALL_DIR = join(RELEASE_DIR, 'tarballs');
/** The one published package (ADR 0189); every other engine package goes in it under its folder's name. */
const ENTRY = 'vibeglobe';
/** Code whose `@vibeglobe/<name>` imports become the single package's own `vibeglobe/<name>` subpaths. */
const REWRITTEN = /\.(js|mjs|ts|mts|map)$/;

export interface PackedPackage {
  name: string;
  version: string;
  /** Absolute path of the tarball. */
  tarball: string;
}

type ExportTarget = string | { readonly [condition: string]: ExportTarget };

/** An exports map's targets moved under `folder`, without the workspace's `source` condition. */
function retarget(target: ExportTarget, folder: string): ExportTarget {
  if (typeof target === 'string') return folder === '' ? target : `./${folder}/${target.replace(/^\.\//, '')}`;
  return Object.fromEntries(
    Object.entries(target)
      .filter(([condition]) => condition !== 'source')
      .map(([condition, value]) => [condition, retarget(value, folder)]),
  );
}

/** A workspace package's exports as subpaths of the single package: `.` becomes `./<folder>`. */
function nestedExports(exports: unknown, folder: string): Record<string, ExportTarget> {
  const entries = (typeof exports === 'string' ? { '.': exports } : exports) as Record<string, ExportTarget>;
  const subpath = (key: string): string => (folder === '' ? key : `./${folder}${key === '.' ? '' : key.slice(1)}`);
  return Object.fromEntries(Object.entries(entries).map(([key, value]) => [subpath(key), retarget(value, folder)]));
}

/** Copies a file into the single package, its engine imports turned into the package's own subpaths. */
function stageFile(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  if (REWRITTEN.test(from)) writeFileSync(to, readFileSync(from, 'utf8').replaceAll('@vibeglobe/', 'vibeglobe/'));
  else cpSync(from, to);
}

/** The single package's third-party dependencies: every engine package's, one range each. */
function thirdPartyDependencies(
  manifests: readonly { dependencies?: Record<string, string> }[],
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const manifest of manifests) {
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      if (name.startsWith('@vibeglobe/')) continue;
      if (merged[name] !== undefined && merged[name] !== range)
        throw new Error(`${name}: two engine packages ask for ${merged[name]} and ${range}`);
      merged[name] = range;
    }
  }
  return Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
}

/** Writes the single package into `stage`: the engine packages' published files, the guides and the manifest. */
function stagePackage(root: string, stage: string, release: string | undefined): void {
  const packages = enginePackages(root);
  const entry = packages.find((pkg) => pkg.manifest.name === ENTRY);
  if (!entry) throw new Error(`no ${ENTRY} package in packages/`);
  const args = [
    'pack',
    '--dry-run',
    '--json',
    '--ignore-scripts',
    ...packages.flatMap((pkg) => ['-w', String(pkg.manifest.name)]),
  ];
  const output = execFileSync('npm', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const listed = JSON.parse(output) as { name: string; files: { path: string }[] }[];
  let exports: Record<string, ExportTarget> = {};
  let bin: Record<string, string> = {};
  for (const pkg of packages) {
    const folder = pkg === entry ? '' : pkg.dir.slice('packages/'.length);
    for (const { path } of listed.find((item) => item.name === pkg.manifest.name)?.files ?? []) {
      if (path === 'package.json' || (folder !== '' && path === 'LICENSE.md')) continue;
      stageFile(join(root, pkg.dir, path), join(stage, folder, path));
    }
    exports = { ...exports, ...nestedExports(pkg.manifest.exports, folder) };
    for (const [command, file] of Object.entries(pkg.manifest.bin ?? {}))
      bin = { ...bin, [command]: retarget(file, folder) as string };
  }
  for (const path of ['docs/guides', 'docs/data-licenses.md', 'llms.txt'])
    cpSync(join(root, path), join(stage, path), { recursive: true });
  const { name, description, license, type, sideEffects, types } = entry.manifest;
  const version = release ?? entry.manifest.version;
  const dependencies = thirdPartyDependencies(packages.map((pkg) => pkg.manifest));
  const peers = { peerDependencies: { vue: '^3.5.0' }, peerDependenciesMeta: { vue: { optional: true } } };
  const manifest = {
    name,
    version,
    description,
    license,
    type,
    sideEffects,
    exports,
    types,
    bin,
    dependencies,
    ...peers,
  };
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Packs VibeGlobe as one npm package into `outDir` (the engine packages' `dist/` must be built): `vibeglobe` at the
 * root, every other engine package under its folder (`vibeglobe/core`, `vibeglobe/layers/vector-tiles`, …), with the
 * guides and `llms.txt`, and no import that leaves the package (ADR 0189, F702). `version`, when given, is the one
 * written in the package, else the facade's.
 */
export function packAll(outDir: string = TARBALL_DIR, root: string = ROOT_DIR, version?: string): PackedPackage[] {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const stage = join(root, '.release/package');
  rmSync(stage, { recursive: true, force: true });
  stagePackage(root, stage, version);
  const args = ['pack', stage, '--json', '--ignore-scripts', '--pack-destination', outDir];
  const output = execFileSync('npm', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const packed = JSON.parse(output) as { name: string; version: string; filename: string }[];
  return packed.map((item) => ({ name: item.name, version: item.version, tarball: join(outDir, item.filename) }));
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
  if (manifest.license !== 'MPL-2.0') problems.push('package.json: license is not MPL-2.0');
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
 * Installs the packed `vibeglobe` into `projectDir`, which holds a package.json: third-party dependencies come from the
 * public registry with no credentials.
 */
export function installTarballs(projectDir: string, packed: readonly PackedPackage[]): void {
  const manifestPath = join(projectDir, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies?: Record<string, string> };
  const dependencies = {
    ...manifest.dependencies,
    ...Object.fromEntries(packed.map((pkg) => [pkg.name, `file:${pkg.tarball}`])),
  };
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, dependencies }, null, 2));
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--userconfig', join(projectDir, '.npmrc-none')], {
    cwd: projectDir,
    stdio: 'inherit',
  });
}

/** A non-code file shipped in a package (scripts/release/assets.json, F519). */
export interface BundledAsset {
  package: string;
  /** Path inside the package; `*` matches within one path segment. */
  path: string;
  source: string;
  license: string;
  /** The text THIRD_PARTY_NOTICES.md carries for a third-party asset. */
  notice?: string;
}

/** Licenses a shipped asset may have: the code licenses, OFL for fonts, public-domain data and the project's own. */
const ASSET_LICENSES = [...ALLOWED_LICENSES, 'Public domain', 'CC0-1.0', 'MPL-2.0', 'License text'];
const CODE_FILE = /\.(js|mjs|d\.ts|d\.mts|map|ts|vue)$|(^|\/)(package\.json|LICENSE\.md|README\.md)$/;

function matches(pattern: string, path: string): boolean {
  const regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
  return regex.test(path);
}

/** Problems of the non-code files of one extracted package against the asset records and the notices (F519). */
export function assetProblems(name: string, root: string, assets: readonly BundledAsset[], notices: string): string[] {
  const problems: string[] = [];
  for (const file of listFiles(root).map((path) => relative(root, path).split(sep).join('/'))) {
    if (CODE_FILE.test(file)) continue;
    const asset = assets.find((candidate) => candidate.package === name && matches(candidate.path, file));
    if (!asset) {
      problems.push(`${file}: a shipped asset with no record in scripts/release/assets.json`);
      continue;
    }
    const font = /\.(woff2?|ttf|otf|pbf)$/.test(file);
    const permitted = asset.license
      .split(' AND ')
      .every((license) => ASSET_LICENSES.includes(license) || (font && FONT_LICENSES.includes(license)));
    if (!permitted) problems.push(`${file}: license ${asset.license} is not permitted`);
    const thirdParty = asset.source !== 'VibeGlobe' && asset.license !== 'License text';
    if (thirdParty && (asset.notice === undefined || !notices.includes(asset.notice)))
      problems.push(`${file}: missing from THIRD_PARTY_NOTICES.md`);
  }
  return problems;
}
