// F710: the checks run on pull requests and when started by hand, never on a push or a merge to main nor on a
// schedule (owner, 2026-11-04, ADR 0192).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT_DIR } from '../workspace.ts';

const WORKFLOWS = join(ROOT_DIR, '.github/workflows');
const workflow = (name: string): string => readFileSync(join(WORKFLOWS, name), 'utf8');

describe('workflow triggers (F710)', () => {
  it('runs CI on pull requests and by hand only', () => {
    expect(workflow('ci.yml')).toMatch(/^on:\n {2}pull_request:\n {2}workflow_dispatch:\n\n/m);
  });

  it('starts nothing on main: no schedule, and a push trigger only for other branches', () => {
    for (const name of readdirSync(WORKFLOWS)) {
      const text = workflow(name);
      expect(text, name).not.toMatch(/^ {2}schedule:/m);
      const push = /^ {2}push:\n((?: {4}.*\n)*)/m.exec(text);
      if (push) expect(push[1], name).toMatch(/branches-ignore: \[main\]/);
      else expect(text, name).not.toMatch(/^ {2}push:/m);
    }
  });
});
