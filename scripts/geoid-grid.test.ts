import { describe, expect, it } from 'vitest';
import { checkReferences, gridFromTriples, readTriples } from './geoid-grid.ts';

/** A 45° text grid of an analytic undulation, with a repeated 180° E column and comments. */
function textGrid(undulation: (lat: number, lon: number) => number): string {
  const lines = ['# latitude longitude undulation'];
  for (let lat = 90; lat >= -90; lat -= 45)
    for (let lon = -180; lon <= 180; lon += 45) lines.push(`${lat} ${lon} ${undulation(lat, lon)}`);
  return lines.join('\n');
}

describe('geoid grid script (F133)', () => {
  it('converts a text grid and checks reference points within a tolerance', () => {
    const plane = (lat: number, lon: number): number => 10 + lat / 10 + lon / 100;
    const model = gridFromTriples(readTriples(textGrid(plane)));
    expect([model.rows, model.columns]).toEqual([5, 8]);
    // A bilinear grid reproduces a function linear in latitude and longitude between its nodes.
    const exact = checkReferences(model, [[30, 20, plane(30, 20)]], 1e-4);
    expect(exact.failures).toEqual([]);
    const wrong = checkReferences(model, [[30, 20, plane(30, 20) + 2]], 1);
    expect(wrong.failures.length).toBe(1);
    expect(wrong.maxErrorMeters).toBeCloseTo(2, 4);
  });

  it('rejects a grid with a missing node or not spanning the poles', () => {
    const lines = textGrid(() => 1).split('\n');
    expect(() => gridFromTriples(readTriples(lines.filter((line) => line !== '0 45 1').join('\n')))).toThrow(
      /not finite/,
    );
    expect(() => gridFromTriples(readTriples(lines.filter((line) => !line.startsWith('-90')).join('\n')))).toThrow(
      /90° N to 90° S/,
    );
    expect(() => readTriples('1 2 x')).toThrow(/not a "latitude longitude value" line/);
  });
});
