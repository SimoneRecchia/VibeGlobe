import { describe, expect, it } from 'vitest';
import { creditsOf, VisibleSources } from './credits.js';

const osm = { text: '© OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright' };

describe('credits (F254, F255)', () => {
  it('credits each text and link once, with every source that asks for it, required credits first', () => {
    const credits = creditsOf([
      { id: 'a', attribution: [{ text: 'Fixture A' }, osm] },
      { id: 'b', attribution: [osm] },
      { id: 'g', attribution: [], profile: { requiredAttribution: { text: 'Google' } } },
    ]);
    expect(credits.map((c) => [c.text, c.required, c.sources])).toEqual([
      ['Google', true, ['g']],
      ['Fixture A', false, ['a']],
      [osm.text, false, ['a', 'b']],
    ]);
  });

  it('hides the credits of hidden sources but keeps a required one, naming its source once', () => {
    const refused: string[] = [];
    const credits = creditsOf(
      [
        { id: 'a', attribution: [{ text: 'Fixture A' }] },
        { id: 'g', attribution: [{ text: 'Extra' }], profile: { requiredAttribution: { text: 'Google' } } },
      ],
      new Set(['a', 'g']),
      (id) => refused.push(id),
    );
    expect(credits.map((c) => c.text)).toEqual(['Google']);
    expect(refused).toEqual(['g']);
  });

  it('reports a change of the visible sources only when the set changes', () => {
    const visible = new VisibleSources(3);
    visible.mark(0);
    expect(visible.settle()).toBe(true);
    visible.mark(0);
    expect(visible.settle()).toBe(false);
    visible.mark(0);
    visible.mark(2);
    expect(visible.settle()).toBe(true);
    expect([visible.visible(0), visible.visible(1), visible.visible(2)]).toEqual([true, false, true]);
  });
});
