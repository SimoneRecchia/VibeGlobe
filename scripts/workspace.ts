// Reads the workspace packages from disk into plain data, so repository checks stay pure functions.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface PackageManifest {
  name?: string;
  private?: boolean;
  type?: string;
  sideEffects?: boolean | string[];
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface TsConfig {
  compilerOptions?: { outDir?: string; tsBuildInfoFile?: string };
}

export interface SourceFile {
  /** Path relative to the repository root, with forward slashes. */
  path: string;
  content: string;
}

export interface WorkspacePackage {
  /** Directory relative to the repository root, for example `packages/core`. */
  dir: string;
  manifest: PackageManifest;
  /** The package's build `tsconfig.json`, when it has one. */
  tsconfig?: TsConfig;
  /** Every file under the package directory except build output and dependencies, relative to the root. */
  files: string[];
  /** TypeScript and Vue sources under `src/`. */
  sources: SourceFile[];
}

export const ROOT_DIR = new URL('..', import.meta.url).pathname;
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'coverage', 'test-results']);

function listFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...listFiles(path));
    else files.push(path);
  }
  return files;
}

export function readWorkspace(rootDir: string = ROOT_DIR): WorkspacePackage[] {
  const packages: WorkspacePackage[] = [];
  for (const group of ['packages', 'apps']) {
    const groupDir = join(rootDir, group);
    if (!existsSync(groupDir)) continue;
    for (const name of readdirSync(groupDir).sort()) {
      const dir = join(groupDir, name);
      if (!statSync(dir).isDirectory()) continue;
      const manifestPath = join(dir, 'package.json');
      const manifest = existsSync(manifestPath)
        ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest)
        : {};
      const tsconfigPath = join(dir, 'tsconfig.json');
      const tsconfig = existsSync(tsconfigPath)
        ? (JSON.parse(readFileSync(tsconfigPath, 'utf8')) as TsConfig)
        : undefined;
      const files = listFiles(dir).map((file) => relative(rootDir, file).split('\\').join('/'));
      const sources = files
        .filter((file) => /\/src\/.*\.(ts|vue)$/.test(file))
        .map((path) => ({ path, content: readFileSync(join(rootDir, path), 'utf8') }));
      packages.push({ dir: `${group}/${name}`, manifest, files, sources, ...(tsconfig ? { tsconfig } : {}) });
    }
  }
  return packages;
}

/** Module specifiers imported by a source file (static, dynamic and side-effect imports, and re-exports). */
export function importSpecifiers(content: string): string[] {
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;
  return [...content.matchAll(pattern)].map((match) => match[1] as string);
}

/** The package name of a bare module specifier (`three/webgpu` → `three`, `@vue/runtime-dom/x` → `@vue/runtime-dom`). */
export function packageNameOf(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return undefined;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}
