// Shipped-dependency closure from package-lock.json and SPDX license evaluation (PLAN.md: permissive licenses only).

export interface LockEntry {
  version?: string;
  license?: string;
  link?: boolean;
  resolved?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

export interface Lockfile {
  packages: Record<string, LockEntry>;
}

export interface ShippedPackage {
  name: string;
  version: string;
  license: string | undefined;
  /** Install path from the lockfile, for example `node_modules/three`. */
  path: string;
}

/** Licenses allowed in anything shipped. OFL-1.1 is allowed for font packages only. */
export const ALLOWED_LICENSES = ['MIT', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'ISC'];
export const FONT_LICENSES = ['OFL-1.1'];

function packageNameFromPath(path: string): string {
  return path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
}

/** Node module resolution over lockfile paths: the package's own node_modules, then each ancestor's, then the root. */
function resolve(lock: Lockfile, fromPath: string, name: string): string | undefined {
  let base = fromPath;
  for (;;) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (lock.packages[candidate]) return candidate;
    if (!base) return undefined;
    const index = base.lastIndexOf('/node_modules/');
    base = index === -1 ? '' : base.slice(0, index);
  }
}

/**
 * Every third-party package reachable through `dependencies`, `peerDependencies` and `optionalDependencies` from the
 * given workspace package paths (for example `packages/core`). Workspace packages themselves are traversed, not listed.
 */
export function shippedPackages(lock: Lockfile, workspacePaths: string[]): ShippedPackage[] {
  const found = new Map<string, ShippedPackage>();
  const visited = new Set<string>();
  const queue = [...workspacePaths];
  while (queue.length > 0) {
    const path = queue.shift() as string;
    if (visited.has(path)) continue;
    visited.add(path);
    const entry = lock.packages[path];
    if (!entry) continue;
    const isWorkspace = !path.includes('node_modules/');
    if (!isWorkspace) {
      found.set(path, { name: packageNameFromPath(path), version: entry.version ?? '', license: entry.license, path });
    }
    const names = Object.keys({ ...entry.dependencies, ...entry.peerDependencies, ...entry.optionalDependencies });
    for (const name of names) {
      const resolved = resolve(lock, path, name);
      if (!resolved) continue;
      const target = lock.packages[resolved];
      queue.push(target?.link && target.resolved ? target.resolved : resolved);
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** Evaluates an SPDX expression (`A OR B`, `A AND B`, parentheses, `WITH` exceptions) against an allowlist. */
export function isLicenseAllowed(expression: string | undefined, allowed: readonly string[]): boolean {
  if (!expression) return false;
  const tokens = expression
    .replace(/[()]/g, (paren) => ` ${paren} `)
    .split(/\s+/)
    .filter(Boolean);
  let position = 0;
  const parseOr = (): boolean => {
    let result = parseAnd();
    while (tokens[position] === 'OR') {
      position++;
      result = parseAnd() || result;
    }
    return result;
  };
  const parseAnd = (): boolean => {
    let result = parseTerm();
    while (tokens[position] === 'AND') {
      position++;
      result = parseTerm() && result;
    }
    return result;
  };
  const parseTerm = (): boolean => {
    const token = tokens[position++];
    if (token === '(') {
      const result = parseOr();
      position++;
      return result;
    }
    if (tokens[position] === 'WITH') position += 2;
    return token !== undefined && allowed.includes(token);
  };
  const result = parseOr();
  return result && position === tokens.length;
}

export function licenseViolations(packages: ShippedPackage[]): string[] {
  return packages
    .filter((pkg) => {
      const allowed = /font/i.test(pkg.name) ? [...ALLOWED_LICENSES, ...FONT_LICENSES] : ALLOWED_LICENSES;
      return !isLicenseAllowed(pkg.license, allowed);
    })
    .map((pkg) => `${pkg.name}@${pkg.version} (${pkg.path}): license "${pkg.license ?? 'missing'}" is not allowed`);
}
