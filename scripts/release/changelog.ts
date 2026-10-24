// The changelog (F526): each release's entry in CHANGELOG.md is generated from the commits since the previous release
// tag, sorted into categories, with breaking changes marked (ADR 0171).
//
//   node scripts/release/changelog.ts <version> [--date YYYY-MM-DD]   adds the entry for <version> to CHANGELOG.md
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_DIR } from '../workspace.ts';

export interface Commit {
  hash: string;
  subject: string;
  body: string;
}

const CATEGORIES = ['Features', 'Bug fixes', 'Performance', 'Documentation', 'Other changes'] as const;
type Category = (typeof CATEGORIES)[number];

const CONVENTIONAL = /^(feat|fix|perf|docs|refactor|test|build|ci|chore|style|revert)(?:\([^)]*\))?(!)?:\s*(.+)$/;
const CONVENTIONAL_TYPES: Record<string, Category> = {
  feat: 'Features',
  fix: 'Bug fixes',
  perf: 'Performance',
  docs: 'Documentation',
};

export const CHANGELOG_HEADER = `# Changelog

Every release of the \`@vibeglobe\` packages, newest first. Each entry is generated from the commit history when the
release is made (\`node scripts/release/changelog.ts\`, run by the release workflow); breaking changes are marked
**Breaking** and listed first. Conventional commit prefixes (\`feat:\`, \`fix:\`, \`perf:\`, \`docs:\`, \`!\` or a
\`BREAKING CHANGE:\` footer for a breaking change) choose the category; other commits are sorted by what they name
(\`F123\` feature entries, \`KB-123\` bug fixes).
`;

/** The category of a commit and whether it breaks the public API. */
export function classify(commit: Commit): { category: Category; breaking: boolean; text: string } {
  const breakingFooter = /^BREAKING[ -]CHANGE:/m.test(commit.body);
  const conventional = CONVENTIONAL.exec(commit.subject);
  if (conventional) {
    const [, type = '', bang, text = commit.subject] = conventional;
    const category = CONVENTIONAL_TYPES[type.toLowerCase()] ?? 'Other changes';
    return { category, breaking: bang === '!' || breakingFooter, text };
  }
  const subject = commit.subject;
  let category: Category = 'Other changes';
  if (/\bKB-\d+\b|^fix(es|ed)?\b/i.test(subject) && !/\bF\d{3}\b/.test(subject)) category = 'Bug fixes';
  else if (/\bF\d{3}\b/.test(subject)) category = 'Features';
  else if (/^docs?\b/i.test(subject)) category = 'Documentation';
  else if (/^perf(ormance)?\b/i.test(subject)) category = 'Performance';
  return { category, breaking: breakingFooter, text: subject };
}

/** The changelog entry of one release. Merge commits of branches are left out; the merged commits are listed. */
export function changelogEntry(version: string, date: string, commits: readonly Commit[]): string {
  const groups = new Map<string, string[]>();
  const add = (group: string, line: string): void => void groups.set(group, [...(groups.get(group) ?? []), line]);
  for (const commit of commits) {
    if (/^Merge (branch|remote-tracking branch|pull request) /.test(commit.subject)) continue;
    const { category, breaking, text } = classify(commit);
    const line = `- ${breaking ? '**Breaking:** ' : ''}${text} (${commit.hash.slice(0, 7)})`;
    if (breaking) add('Breaking changes', line);
    add(category, line);
  }
  const sections = ['Breaking changes', ...CATEGORIES]
    .filter((group) => groups.has(group))
    .map((group) => `### ${group}\n\n${(groups.get(group) ?? []).join('\n')}\n`);
  return [`## ${version} (${date})\n`, ...(sections.length ? sections : ['No changes.\n'])].join('\n');
}

/** CHANGELOG.md with the entry of `version` added above the earlier ones; refuses a version already listed. */
export function addEntry(changelog: string, version: string, entry: string): string {
  const current = changelog.trim() === '' ? CHANGELOG_HEADER : changelog;
  if (current.includes(`\n## ${version} (`)) throw new Error(`CHANGELOG.md already has an entry for ${version}`);
  const first = current.indexOf('\n## ');
  return first < 0
    ? `${current.trimEnd()}\n\n${entry}`
    : `${current.slice(0, first + 1)}${entry}\n${current.slice(first + 1)}`;
}

/** The commits since the newest release tag (`v*`) reachable from HEAD, or the whole history before the first release. */
export function commitsSinceLastRelease(cwd: string = ROOT_DIR): Commit[] {
  let range = 'HEAD';
  try {
    const tag = execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    range = `${tag}..HEAD`;
  } catch {
    // No release yet: the whole history.
  }
  const log = execFileSync('git', ['log', '--format=%H%x1f%s%x1f%b%x1e', range], { cwd, encoding: 'utf8' });
  return log
    .split('\x1e')
    .map((record) => record.trim())
    .filter((record) => record !== '')
    .map((record) => {
      const [hash = '', subject = '', body = ''] = record.split('\x1f');
      return { hash, subject, body };
    });
}

/** Adds the entry of `version` to `<cwd>/CHANGELOG.md` and returns it. */
export function writeChangelog(version: string, date: string, cwd: string = ROOT_DIR): string {
  const path = join(cwd, 'CHANGELOG.md');
  const entry = changelogEntry(version, date, commitsSinceLastRelease(cwd));
  writeFileSync(path, addEntry(existsSync(path) ? readFileSync(path, 'utf8') : '', version, entry));
  return entry;
}

if (import.meta.main) {
  const [version] = process.argv.slice(2);
  const dateIndex = process.argv.indexOf('--date');
  const date = dateIndex > 0 ? (process.argv[dateIndex + 1] ?? '') : new Date().toISOString().slice(0, 10);
  if (!version) throw new Error('usage: node scripts/release/changelog.ts <version> [--date YYYY-MM-DD]');
  console.log(writeChangelog(version, date));
}
