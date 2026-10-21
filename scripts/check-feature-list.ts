// Fails when feature_list.json breaks ADR 0003 relative to its first committed version and to a base revision
// (default HEAD; CI passes the commit before the push or the pull request base): `--base <rev>`. Superseded entries
// must be recorded in docs/feature-changes.md (ADR 0016) and pending ones in docs/open-questions.md (ADR 0017).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadFeatureList } from './feature-list.ts';
import { featureListViolationsSince } from './checks/feature-list-history.ts';
import { findPendingViolations, findSupersessionViolations } from './checks/feature-list-integrity.ts';
import { ROOT_DIR } from './workspace.ts';

const baseIndex = process.argv.indexOf('--base');
const baseRevision = baseIndex === -1 ? 'HEAD' : (process.argv[baseIndex + 1] as string);
const { compared, violations } = featureListViolationsSince(ROOT_DIR, baseRevision);
const recordPath = join(ROOT_DIR, 'docs', 'feature-changes.md');
const record = existsSync(recordPath) ? readFileSync(recordPath, 'utf8') : '';
const list = loadFeatureList();
violations.push(...findSupersessionViolations(list, record));
violations.push(...findPendingViolations(list, readFileSync(join(ROOT_DIR, 'docs', 'open-questions.md'), 'utf8')));
for (const violation of violations) console.error(violation);
if (violations.length > 0) process.exit(1);
console.log(
  `feature_list.json integrity OK (compared with ${compared.map((r) => r.slice(0, 12)).join(', ') || 'nothing yet'})`,
);
