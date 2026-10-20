// Detects removed tests and loosened quality gates between two versions of the repository (PLAN.md: tests protect
// the work). Anything named in the test-changes log is accepted as a recorded, justified change.

/**
 * Titles of the test cases and suites declared in a test file: `it`, `test` and `describe` with any chained modifiers
 * (`.concurrent`, `.sequential`, `.fails`, `.serial`, …) and `.each`, `.for` or `.prop` templates, including
 * tagged-template tables.
 */
export function testTitles(content: string): string[] {
  const pattern =
    /\b(?:it|test|describe)(?:\.(?!each\b|for\b|prop\b)[A-Za-z]+)*(?:\.(?:each|for|prop)\b(?:`[^`]*`\s*|[\s\S]*?\)\s*))?\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
  return [...content.matchAll(pattern)].map((match) => match[2] as string);
}

function counts(values: string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

/** Test files (path → content) removed or missing test cases relative to `base`, unless recorded in `log`. */
export function findRemovedTests(base: Map<string, string>, current: Map<string, string>, log: string): string[] {
  const violations: string[] = [];
  for (const [path, baseContent] of base) {
    const currentContent = current.get(path);
    if (currentContent === undefined) {
      if (!log.includes(path)) violations.push(`${path}: test file deleted`);
      continue;
    }
    const currentCounts = counts(testTitles(currentContent));
    for (const [title, count] of counts(testTitles(baseContent))) {
      if ((currentCounts.get(title) ?? 0) < count && !(log.includes(path) && log.includes(title))) {
        violations.push(`${path}: test "${title}" removed`);
      }
    }
  }
  return violations;
}

type GateDirection = 'minimum' | 'maximum';

function numericLeaves(value: unknown, prefix = ''): Map<string, number> {
  const leaves = new Map<string, number>();
  if (typeof value === 'number') leaves.set(prefix, value);
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      for (const [path, number] of numericLeaves(child, prefix ? `${prefix}.${key}` : key)) leaves.set(path, number);
    }
  }
  return leaves;
}

/**
 * Numeric gates in a JSON file that were loosened or removed: for `minimum` gates (coverage) a lower value loosens,
 * for `maximum` gates (budgets, tolerances) a higher one does. Each is accepted if the log names `<file> <key path>`.
 */
export function findLoosenedGates(
  file: string,
  direction: GateDirection,
  base: unknown,
  current: unknown,
  log: string,
): string[] {
  const currentLeaves = numericLeaves(current);
  const violations: string[] = [];
  for (const [path, baseValue] of numericLeaves(base)) {
    const value = currentLeaves.get(path);
    const loosened = value === undefined || (direction === 'minimum' ? value < baseValue : value > baseValue);
    if (loosened && !log.includes(`${file} ${path}`)) {
      violations.push(`${file} ${path}: ${value === undefined ? 'removed' : `loosened from ${baseValue} to ${value}`}`);
    }
  }
  return violations;
}

/**
 * Entries newly added to an exclusion list in a JSON gate file (for example `bundleExternal`, which leaves packages
 * out of the bundle-size measurement and so loosens the budgets), unless the log names `<file> <key> <entry>`.
 */
export function findAddedExclusions(file: string, key: string, base: unknown, current: unknown, log: string): string[] {
  const list = (value: unknown): string[] => {
    const entries = (value as Record<string, unknown> | null)?.[key];
    return Array.isArray(entries) ? entries.map(String) : [];
  };
  const before = new Set(list(base));
  return list(current)
    .filter((entry) => !before.has(entry) && !log.includes(`${file} ${key} ${entry}`))
    .map((entry) => `${file} ${key}: "${entry}" added (it loosens the bundle-size budgets)`);
}
