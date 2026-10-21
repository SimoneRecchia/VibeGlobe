import type { WorkspacePackage } from '../workspace.ts';

/** Library packages required by PLAN.md "Architecture guidance", published as `@vibeglobe/<dir>`. */
export const LIBRARY_PACKAGES = [
  'core',
  'renderer',
  'sources',
  'worker',
  'layers',
  'controls',
  'offline',
  'ui',
  'vue',
  'web-component',
  'tools',
];
const REQUIRED_APPS = ['playground'];

/** SPDX identifier that every package.json declares, the root included (ADR 0015). */
export const PROJECT_LICENSE = 'PolyForm-Noncommercial-1.0.0';

/** Reports a manifest at `dir` whose license is not the project license. */
export function findLicenseViolation(dir: string, license: string | undefined): string[] {
  return license === PROJECT_LICENSE ? [] : [`${dir}: package.json must declare "license": "${PROJECT_LICENSE}"`];
}

/**
 * Every package follows one layout: package.json, src/, a CLAUDE.md, ESM, a lowercase name, tests next to code; library
 * packages also have a `src/index.ts` entry and are side-effect free.
 */
export function findStructureViolations(packages: WorkspacePackage[]): string[] {
  const violations: string[] = [];
  const dirs = new Set(packages.map((pkg) => pkg.dir));
  for (const name of LIBRARY_PACKAGES)
    if (!dirs.has(`packages/${name}`)) violations.push(`packages/${name}: missing package`);
  for (const name of REQUIRED_APPS) if (!dirs.has(`apps/${name}`)) violations.push(`apps/${name}: missing app`);

  for (const pkg of packages) {
    const has = (file: string): boolean => pkg.files.includes(`${pkg.dir}/${file}`);
    const isLibrary = pkg.dir.startsWith('packages/');
    const folder = pkg.dir.split('/')[1] ?? '';
    const expectedName = `@vibeglobe/${folder}`;
    if (!has('package.json')) violations.push(`${pkg.dir}: missing package.json`);
    if (!has('CLAUDE.md')) violations.push(`${pkg.dir}: missing CLAUDE.md`);
    if (!pkg.files.some((file) => file.startsWith(`${pkg.dir}/src/`))) violations.push(`${pkg.dir}: missing src/`);
    if (folder !== folder.toLowerCase()) violations.push(`${pkg.dir}: package folder names must be lowercase`);
    else if (pkg.manifest.name !== expectedName) violations.push(`${pkg.dir}: package name must be "${expectedName}"`);
    violations.push(...findLicenseViolation(pkg.dir, pkg.manifest.license));
    if (pkg.manifest.type !== 'module') violations.push(`${pkg.dir}: package.json must declare "type": "module"`);
    if (isLibrary && !has('src/index.ts')) violations.push(`${pkg.dir}: missing src/index.ts entry point`);
    if (isLibrary && pkg.manifest.sideEffects !== false)
      violations.push(`${pkg.dir}: package.json must declare "sideEffects": false`);
    // The build info must live inside the output folder: deleting dist/ then forces tsc -b to rebuild (KB-002).
    const options = pkg.tsconfig?.compilerOptions;
    if (isLibrary && !(options?.outDir && options.tsBuildInfoFile?.startsWith(`${options.outDir}/`))) {
      violations.push(`${pkg.dir}: tsconfig.json must set "tsBuildInfoFile" inside its "outDir"`);
    }
    for (const file of pkg.files) {
      if (/\/(test|tests|__tests__)\//.test(file))
        violations.push(`${file}: tests live next to the code they test, not in a test folder`);
      if (/\.(test|spec)\.ts$/.test(file) && !file.startsWith(`${pkg.dir}/src/`)) {
        violations.push(`${file}: tests live next to the code they test, inside src/`);
      }
    }
  }
  return violations;
}
