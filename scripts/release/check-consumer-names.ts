// F559: nothing in the repository names a consumer application (PLAN.md; owner, 2026-11-04, ADR 0188). The names are
// kept only as SHA-256 hashes, so this check does not name them either: it hashes every word of every tracked text
// file, and every part of every dependency's name, and compares.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_DIR } from '../workspace.ts';

/** The hashes of the consumers' names as written in text, case included. */
const NAME_HASHES: ReadonlySet<string> = new Set([
  '67a9f6a6b5b7269d0bfd4b6f313ee77abb040d78dedc1473b04b911154eb1ac8',
  'ec6c91effa84896355606ad5946c00f52a95ab40bc4694a531f4a1b3fb0af043',
  '5f1ca2e3b5fa9fd07e864e006ce04811ba6fe5b99606132616627b768644fb4c',
  'fbb288137b9d61027efcb0211b5ff90f6fbc910f0a82decc3488d1de1562371d',
]);
/** The hashes of the consumers' names in lowercase, as parts of a package name or scope. */
export const PACKAGE_HASHES: ReadonlySet<string> = new Set([
  '4f3c4172a4fe308cebc840da665171f534849b1fca101eaf635d68fb453393db',
  '5f1ca2e3b5fa9fd07e864e006ce04811ba6fe5b99606132616627b768644fb4c',
]);

const WORD = /\b[A-Za-z][A-Za-z0-9]*\b/g;
/** A word followed by "map" or "maps" is a texture's name, not a product's (cube maps). */
const MAP_AFTER = /^ ?maps?\b/;
const hashes = new Map<string, string>();
const sha256 = (text: string): string => {
  let hash = hashes.get(text);
  if (hash === undefined) hashes.set(text, (hash = createHash('sha256').update(text).digest('hex')));
  return hash;
};

/** Whether a line names a consumer. */
function namesConsumer(line: string, names: ReadonlySet<string> = NAME_HASHES): boolean {
  for (const match of line.matchAll(WORD)) {
    const end = match.index + match[0].length;
    if (names.has(sha256(match[0])) && !MAP_AFTER.test(line.slice(end))) return true;
  }
  return false;
}

/** Whether a package name or scope (`@scope/name`) is a consumer's. */
export function isConsumerPackage(name: string, names: ReadonlySet<string> = PACKAGE_HASHES): boolean {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((part) => part !== '' && names.has(sha256(part)));
}

/** Lines that name a consumer in the given files' contents, as `path:line`, never the line itself. */
export function consumerReferences(
  files: ReadonlyMap<string, string>,
  names: ReadonlySet<string> = NAME_HASHES,
): string[] {
  const found: string[] = [];
  for (const [path, content] of files) {
    content.split('\n').forEach((line, index) => {
      if (namesConsumer(line, names)) found.push(`${path}:${index + 1}`);
    });
  }
  return found;
}

/**
 * The tracked text files of the repository at `root`, with their contents. Some are large (the owner's benchmark
 * results run to tens of MB, KB-197): git's list may be read up to 1 GB.
 */
export function trackedTextFiles(root: string = ROOT_DIR): Map<string, string> {
  const listed = execFileSync('git', ['grep', '-I', '-l', '-e', ''], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1 << 30,
  })
    .split('\n')
    .filter((path) => path !== '');
  return new Map(listed.map((path) => [path, readFileSync(join(root, path), 'utf8')]));
}

if (import.meta.main) {
  const files = trackedTextFiles();
  const found = consumerReferences(files);
  for (const line of found) console.error(`FAIL  ${line}: names a consumer application`);
  console.log(found.length === 0 ? `ok    no consumer named in ${files.size} tracked files` : '');
  process.exit(found.length === 0 ? 0 : 1);
}
