// The third-party packages shipped with the published packages, read from package-lock.json.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shippedPackages, type Lockfile, type ShippedPackage } from './licenses.ts';
import { ROOT_DIR, enginePackages } from './workspace.ts';

export function readShippedPackages(lockfilePath = join(ROOT_DIR, 'package-lock.json')): ShippedPackage[] {
  const lock = JSON.parse(readFileSync(lockfilePath, 'utf8')) as Lockfile;
  const published = enginePackages();
  return shippedPackages(
    lock,
    published.map((pkg) => pkg.dir),
  );
}
