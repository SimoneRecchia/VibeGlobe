import { describe, expect, it } from 'vitest';
import type { Feature, FeatureList } from '../feature-list.ts';
import {
  findFeatureListViolations,
  findPendingViolations,
  findSupersessionViolations,
} from './feature-list-integrity.ts';

function feature(id: string, overrides: Partial<Feature> = {}): Feature {
  return {
    id,
    milestone: 1,
    section: 'S',
    description: `Behavior ${id}`,
    steps: ['a', 'b'],
    status: 'failing',
    ...overrides,
  };
}

function list(...features: Feature[]): FeatureList {
  return { milestones: { '1': 'One', '2': 'Two' }, features };
}

describe('findFeatureListViolations', () => {
  const base = list(feature('F001'), feature('F002'), feature('F003', { milestone: 2 }));

  it('accepts an unchanged list', () => {
    expect(findFeatureListViolations(base, structuredClone(base))).toEqual([]);
  });

  it('accepts status changes and appended entries', () => {
    const current = list(
      feature('F001', { status: 'passing' }),
      feature('F002'),
      feature('F004'),
      feature('F003', { milestone: 2 }),
    );
    expect(findFeatureListViolations(base, current)).toEqual([]);
  });

  it('accepts a superseded status, which changes nothing else (ADR 0016)', () => {
    const current = list(feature('F001', { status: 'superseded' }), feature('F002'), feature('F003', { milestone: 2 }));
    expect(findFeatureListViolations(base, current)).toEqual([]);
  });

  it('rejects a deleted entry', () => {
    expect(findFeatureListViolations(base, list(feature('F001'), feature('F003', { milestone: 2 })))).toEqual([
      'F002: deleted',
    ]);
  });

  it('rejects reworded descriptions and steps, and moved milestones', () => {
    const current = list(
      feature('F001', { description: 'Easier behavior' }),
      feature('F002', { steps: ['a'] }),
      feature('F003', { milestone: 3 }),
    );
    expect(findFeatureListViolations(base, current)).toEqual([
      'F001: description changed',
      'F002: steps changed',
      'F003: milestone changed',
    ]);
  });

  it('rejects reordered entries', () => {
    const current = list(feature('F002'), feature('F001'), feature('F003', { milestone: 2 }));
    expect(findFeatureListViolations(base, current)).toEqual(['F002: reordered']);
  });

  it('rejects invalid statuses, duplicate ids, unknown fields and renamed milestones', () => {
    const current: FeatureList = {
      milestones: { '1': 'One', '2': 'Renamed' },
      features: [
        feature('F001', { status: 'done' as Feature['status'] }),
        feature('F002'),
        feature('F002'),
        { ...feature('F003', { milestone: 2 }), priority: 1 } as Feature,
      ],
    };
    expect(findFeatureListViolations(base, current)).toEqual([
      'F001: invalid status "done"',
      'F002: duplicate id',
      'F003: unknown field "priority"',
      'milestone 2: renamed or removed',
    ]);
  });
});

describe('findSupersessionViolations', () => {
  const record = [
    '| Entry | Replaced by | Owner decision | Why it can no longer pass |',
    '| ----- | ----------- | -------------- | ------------------------- |',
    '| F001  | F003, F004  | 2026-10-20     | Renamed                   |',
  ].join('\n');

  it('accepts superseded entries recorded with existing, active replacements', () => {
    const current = list(feature('F001', { status: 'superseded' }), feature('F002'), feature('F003'), feature('F004'));
    expect(findSupersessionViolations(current, record)).toEqual([]);
  });

  it('rejects an unrecorded supersession and a record that does not match the list', () => {
    const current = list(
      feature('F001'),
      feature('F002', { status: 'superseded' }),
      feature('F003', { status: 'superseded' }),
    );
    expect(findSupersessionViolations(current, record)).toEqual([
      'F002: superseded but not recorded in docs/feature-changes.md',
      'F003: superseded but not recorded in docs/feature-changes.md',
      'F001: recorded in docs/feature-changes.md but its status is "failing"',
      'F001: replacement F003 is itself superseded',
      'F001: replacement F004 does not exist',
    ]);
  });

  it('rejects a recorded entry without a replacement', () => {
    const current = list(feature('F001', { status: 'superseded' }));
    expect(findSupersessionViolations(current, '| F001 | none | 2026-10-20 | Dropped |')).toEqual([
      'F001: no replacement recorded in docs/feature-changes.md',
    ]);
  });
});

describe('findPendingViolations', () => {
  const questions = [
    '## Pending owner steps',
    '',
    '| Entry | Owner-only step | Prepared |',
    '| ----- | --------------- | -------- |',
    '| F001  | Run the procedure on the reference desktop | Procedure written |',
  ].join('\n');

  it('accepts pending entries listed with their owner-only step', () => {
    expect(findPendingViolations(list(feature('F001', { status: 'pending' }), feature('F002')), questions)).toEqual([]);
  });

  it('rejects unlisted pending entries and listed entries that are not pending', () => {
    expect(findPendingViolations(list(feature('F001'), feature('F002', { status: 'pending' })), questions)).toEqual([
      'F002: pending but not listed under "Pending owner steps" in docs/open-questions.md',
      'F001: listed under "Pending owner steps" in docs/open-questions.md but its status is "failing"',
    ]);
  });

  it('ignores entry ids outside the pending section', () => {
    const text = '| F009 | some other table |\n' + questions;
    expect(findPendingViolations(list(feature('F001', { status: 'pending' })), text)).toEqual([]);
  });
});
