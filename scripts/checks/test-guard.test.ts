import { describe, expect, it } from 'vitest';
import { findLoosenedGates, findRemovedTests, testTitles } from './test-guard.ts';

describe('testTitles', () => {
  it('finds suites, cases, .each templates and escaped quotes', () => {
    const source = [
      "describe('suite', () => {",
      "  it('first case', () => {});",
      '  test("second \\"quoted\\" case", () => {});',
      "  it.each([['a', 1], ['b', 2]])('each %s', () => {});",
      '  it(`template case`, () => {});',
      '});',
    ].join('\n');
    expect(testTitles(source)).toEqual(['suite', 'first case', 'second \\"quoted\\" case', 'each %s', 'template case']);
  });
});

describe('findRemovedTests', () => {
  const base = new Map([
    ['a.test.ts', "it('one', () => {});\nit('two', () => {});"],
    ['b.test.ts', "it('three', () => {});"],
  ]);

  it('accepts unchanged and added tests', () => {
    const current = new Map([
      ...base,
      ['a.test.ts', "it('one', () => {});\nit('two', () => {});\nit('new', () => {});"],
    ]);
    expect(findRemovedTests(base, current, '')).toEqual([]);
  });

  it('reports deleted files and removed cases', () => {
    const current = new Map([['a.test.ts', "it('one', () => {});"]]);
    expect(findRemovedTests(base, current, '')).toEqual([
      'a.test.ts: test "two" removed',
      'b.test.ts: test file deleted',
    ]);
  });

  it('accepts removals recorded in the log', () => {
    const current = new Map([['a.test.ts', "it('one', () => {});"]]);
    const log =
      '| 2026-10-20 | a.test.ts "two" | removed | duplicate of "one" |\n| 2026-10-20 | b.test.ts | deleted | moved |';
    expect(findRemovedTests(base, current, log)).toEqual([]);
  });

  it('reports a duplicated title that lost one occurrence', () => {
    const twice = new Map([['a.test.ts', "it('same', () => {});\nit('same', () => {});"]]);
    const once = new Map([['a.test.ts', "it('same', () => {});"]]);
    expect(findRemovedTests(twice, once, '')).toEqual(['a.test.ts: test "same" removed']);
  });
});

describe('findLoosenedGates', () => {
  it('reports lower minima and higher maxima, and removed gates', () => {
    expect(findLoosenedGates('coverage.json', 'minimum', { core: { lines: 90 } }, { core: { lines: 85 } }, '')).toEqual(
      ['coverage.json core.lines: loosened from 90 to 85'],
    );
    expect(findLoosenedGates('budgets.json', 'maximum', { a: { ms: 6, kb: 10 } }, { a: { ms: 7 } }, '')).toEqual([
      'budgets.json a.ms: loosened from 6 to 7',
      'budgets.json a.kb: removed',
    ]);
  });

  it('accepts tightened gates and recorded changes', () => {
    expect(findLoosenedGates('coverage.json', 'minimum', { lines: 90 }, { lines: 95 }, '')).toEqual([]);
    expect(findLoosenedGates('budgets.json', 'maximum', { a: { ms: 6 } }, { a: { ms: 4 } }, '')).toEqual([]);
    expect(
      findLoosenedGates(
        'budgets.json',
        'maximum',
        { a: { ms: 6 } },
        { a: { ms: 8 } },
        'budgets.json a.ms raised: new scenario',
      ),
    ).toEqual([]);
  });
});
