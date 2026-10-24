// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
/**
 * Resumable steps (F335): every completed item (a download, an intermediate or encoded tile) is written atomically and
 * then appended to a JSON-lines log with its SHA-256. A rerun skips an item only when its file still matches.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** SHA-256 of bytes, hex. */
export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Writes a file atomically: a temporary sibling, then a rename. */
export function writeAtomic(path: string, bytes: Uint8Array | string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.partial-${process.pid}`;
  writeFileSync(temporary, bytes);
  renameSync(temporary, path);
}

/** One log entry. */
interface Entry {
  step: string;
  key: string;
  sha256: string;
}

/** Outcome of checking an item before redoing it. */
export type ItemState = 'done' | 'missing' | 'corrupt';

/** The log of one dataset build. */
export class StepLog {
  private readonly entries = new Map<string, string>();

  /** Whether the log was written for another fingerprint: everything but the downloads was dropped. */
  readonly changed: boolean = false;

  /**
   * Opens the log of `path`. With a fingerprint (of the dataset's configuration, `work`, and of its source alone,
   * `source`), a log written for another configuration keeps only its downloads, and only when the source is the same:
   * the rest is redone (DP-002).
   */
  constructor(
    private readonly path: string,
    fingerprint?: { readonly work: string; readonly source: string },
  ) {
    if (!existsSync(path)) {
      if (fingerprint !== undefined) this.#start(fingerprint);
      return;
    }
    let logged: { work?: string; source?: string } = {};
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      try {
        const entry = JSON.parse(line) as Entry | { fingerprint: { work?: string; source?: string } };
        if ('fingerprint' in entry) logged = entry.fingerprint;
        else this.entries.set(`${entry.step}\u0000${entry.key}`, entry.sha256);
      } catch {
        // A process killed while appending leaves a partial last line: the item is simply redone.
      }
    }
    if (fingerprint === undefined || logged.work === fingerprint.work) return;
    this.changed = true;
    const sameSource = logged.source === fingerprint.source;
    const kept = [...this.entries].filter(([key]) => sameSource && key.startsWith('download\u0000'));
    this.entries.clear();
    this.#start(fingerprint);
    for (const [key, checksum] of kept) {
      const [step = '', item = ''] = key.split('\u0000');
      this.record(step, item, checksum);
    }
  }

  #start(fingerprint: { readonly work: string; readonly source: string }): void {
    writeAtomic(this.path, `${JSON.stringify({ fingerprint })}\n`);
  }

  /** The checksum logged for an item. */
  logged(step: string, key: string): string | undefined {
    return this.entries.get(`${step}\u0000${key}`);
  }

  /** Whether the file of an item exists and matches its logged checksum. */
  check(step: string, key: string, file: string): ItemState {
    const expected = this.logged(step, key);
    if (expected === undefined || !existsSync(file)) return 'missing';
    return sha256(readFileSync(file)) === expected ? 'done' : 'corrupt';
  }

  /** Records a completed item. */
  record(step: string, key: string, checksum: string): void {
    this.entries.set(`${step}\u0000${key}`, checksum);
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify({ step, key, sha256: checksum })}\n`);
  }

  /** Writes an item atomically and records it. */
  write(step: string, key: string, file: string, bytes: Uint8Array): string {
    writeAtomic(file, bytes);
    const checksum = sha256(bytes);
    this.record(step, key, checksum);
    return checksum;
  }
}
