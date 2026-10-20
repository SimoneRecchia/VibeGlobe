// Fails when a shipped dependency has a license outside the permissive allowlist. `--lockfile <path>` audits
// another lockfile (used to demonstrate the audit on a modified copy).
import { ALLOWED_LICENSES, FONT_LICENSES, licenseViolations } from './licenses.ts';
import { readShippedPackages } from './shipped-dependencies.ts';

const lockfileIndex = process.argv.indexOf('--lockfile');
const shipped = readShippedPackages(lockfileIndex === -1 ? undefined : process.argv[lockfileIndex + 1]);
const violations = licenseViolations(shipped);
for (const violation of violations) console.error(violation);
if (violations.length > 0) process.exit(1);
console.log(
  `License audit OK: ${shipped.length} shipped third-party packages, all under ${ALLOWED_LICENSES.join(', ')} (${FONT_LICENSES.join(', ')} for fonts).`,
);
