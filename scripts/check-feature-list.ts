// Fails when feature_list.json breaks ADR 0003 relative to its first committed version and to a base revision
// (default HEAD; CI passes the commit before the push or the pull request base): `--base <rev>`.
import { featureListViolationsSince } from './checks/feature-list-history.ts';
import { ROOT_DIR } from './workspace.ts';

const baseIndex = process.argv.indexOf('--base');
const baseRevision = baseIndex === -1 ? 'HEAD' : (process.argv[baseIndex + 1] as string);
const { compared, violations } = featureListViolationsSince(ROOT_DIR, baseRevision);
for (const violation of violations) console.error(violation);
if (violations.length > 0) process.exit(1);
console.log(
  `feature_list.json integrity OK (compared with ${compared.map((r) => r.slice(0, 12)).join(', ') || 'nothing yet'})`,
);
