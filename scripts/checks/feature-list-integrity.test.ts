import { describe, expect, it } from 'vitest';
import type { Feature, FeatureList } from '../feature-list.ts';
import { findFeatureListViolations } from './feature-list-integrity.ts';

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
