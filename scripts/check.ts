// Repository checks that must always hold: package layout, dependency rules and hot-path documentation.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findDependencyViolations } from './checks/dependencies.ts';
import { findHotPathViolations } from './checks/hot-paths.ts';
import { findStructureViolations } from './checks/structure.ts';
import { ROOT_DIR, readWorkspace } from './workspace.ts';

const packages = readWorkspace();
const results: [string, string[]][] = [
  ['structure', findStructureViolations(packages)],
  ['dependency rules', findDependencyViolations(packages)],
  [
    'hot paths',
    findHotPathViolations(
      packages.flatMap((pkg) => pkg.sources),
      (path) => existsSync(join(ROOT_DIR, path)),
    ),
  ],
];

let failed = false;
for (const [name, violations] of results) {
  for (const violation of violations) console.error(`${name}: ${violation}`);
  failed ||= violations.length > 0;
  if (violations.length === 0) console.log(`${name}: OK`);
}
if (failed) process.exit(1);
