import { describe, expect, it } from 'vitest';
import type { Credit } from '@vibeglobe/core';
import { assertRequiredLogos, layoutCredits } from './screenshot.js';

describe('the credit strip of a screenshot (F416, KB-168)', () => {
  it('wraps credits wider than the image onto rows, in order', () => {
    expect(layoutCredits([100, 120, 90], 250, 10)).toEqual({ rows: [[0, 1], [2]], scale: 1, widthPx: 230 });
    expect(layoutCredits([100, 120], 400, 10)).toEqual({ rows: [[0, 1]], scale: 1, widthPx: 230 });
  });

  it('shrinks every credit when one alone is wider than the image', () => {
    const { rows, scale } = layoutCredits([600, 100], 300, 10);
    expect(scale).toBeCloseTo(0.5, 9);
    expect(rows).toEqual([[0], [1]]);
  });
});

describe('the required logos of a screenshot (F416, KB-167)', () => {
  const credit = (required: boolean): Credit =>
    ({ text: 'Provider', required, sources: [], logo: { src: 'https://cdn.test/logo.png' } }) as unknown as Credit;

  it('fails the export when a required logo did not load, and accepts an optional one missing', () => {
    expect(() => assertRequiredLogos([{ credit: credit(true), logo: undefined }])).toThrow(
      /required logo of "Provider"/,
    );
    expect(() => assertRequiredLogos([{ credit: credit(false), logo: undefined }])).not.toThrow();
    expect(() => assertRequiredLogos([{ credit: credit(true), logo: {} }])).not.toThrow();
  });
});
